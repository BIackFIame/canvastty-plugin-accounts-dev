// Service entry (bundled to services/accounts.mjs): wires the Accounts service to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { AccountsService, type LaunchContext } from './accounts.ts';
import { networkFetch } from '../quota/reader.ts';

// Requests that arrive while the service is still reading its storage wait for it (CanvasTTY's own timeouts bound
// the wait; a launch that is not answered is refused there, never started without its account).
let resolveReady: (service: AccountsService) => void;
const ready = new Promise<AccountsService>(resolve => { resolveReady = resolve; });
const service = async (): Promise<AccountsService> => { const accounts = await ready; await accounts.load(); return accounts; };

let started: AccountsService | null = null;

serve({
  // The quota state is written before the process ends (CanvasTTY waits about 2 s after shutdown).
  exit: code => {
    const done = (): never => process.exit(code);
    setTimeout(done, 500).unref();
    void Promise.allSettled([started?.quota.stop(), started?.pools.stop()]).finally(done);
  },
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    // A failed read is not "nothing saved": the service then reads again on each request and refuses until it can,
    // so an empty list is never shown or saved over the person's accounts.
    const read = await host.callHost('storage.get', { key: 'accounts' }).then(value => ({ value }), () => null);
    if (!read) host.log('warn', 'The saved accounts could not be read; reading them again on the next request.');
    const pools = await host.callHost('storage.get', { key: 'pools' }).then(value => ({ value }), () => null);
    started = new AccountsService({ host, dataDir, quotaFetch: networkFetch, ...(read ? { saved: read.value } : { unread: true }), ...(pools ? { savedPools: pools.value } : { poolsUnread: true }) });
    // Quotas are read on the reader's own schedule from now on, whether or not any page is open.
    started.quota.start();
    // Pools: card events (one card per sign-in) and CanvasTTY's quota reads of each account home.
    await started.pools.start();
    resolveReady(started);
  },
  notifications: {
    'canvastty.sessions.event': params => { void service().then(accounts => accounts.sessionEvent(params)).catch(() => undefined); },
    'canvastty.limits.changed': params => { void service().then(accounts => accounts.pools.limitsChanged(params)).catch(() => undefined); },
    // limit.exhausted: provider-wide for the default login (remembered and shown), or a named account of ours (rests).
    'canvastty.activity': params => { void service().then(accounts => accounts.activity(params)).catch(() => undefined); }
  },
  methods: {
    // Host-only requests.
    'canvastty.launch.options': async params => (await service()).launchOptions(params.provider),
    'canvastty.launch.prepare': async params => (await service()).prepare(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await service()).tool(String(params.tool), (params.input ?? {}) as Record<string, unknown>),
    // A shared read another plugin's service asked for; CanvasTTY sends it only for a pair the person approved.
    'canvastty.shares.read': async params => (await service()).shareRead(params),
    // Brokered requests: CanvasTTY asks which marked accounts are offered, admits each request here and settles it.
    'canvastty.broker.offer': async () => (await service()).brokerOffer(),
    'canvastty.broker.admit': async params => (await service()).brokerAdmit(params),
    'canvastty.broker.settle': async params => (await service()).brokerSettle(params),
    // The settings page.
    state: async () => (await service()).state(),
    save: async params => (await service()).save(params.settings),
    check: async params => (await service()).check(params.accountId),
    keyChanged: async params => (await service()).keyChanged(params.accountId),
    quotaRead: async params => (await service()).readQuota(params.accountId),
    planAdd: async params => (await service()).planAdd(params),
    poolAdd: async params => (await service()).poolAdd(params),
    poolSignIn: async params => (await service()).poolSignIn(params.accountId),
    poolUpdate: async params => (await service()).poolUpdate(params),
    poolRemove: async params => (await service()).poolRemove(params.accountId),
    poolCheck: async params => (await service()).poolCheck(params.accountId)
  }
});

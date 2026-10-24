import type { Host } from '../rpc.ts';
import { apiKeyProblem, apiKeyProblemMessage, envSubstitutionProblem, openCodeKeyRefusal } from '../shared/apiKeyHygiene.ts';
import {
  DECISIONS_ONLY_REASON, HARNESS_LABELS, HARNESSES, PRESETS, accountKeyed, decisionsOnlyAccount, harnessSupport, loadSettings, ollamaShapeOf,
  brokerOfferOf, newAccountId, ollamaWireModel, protocolOf, secretKeyOf, validateSettings, type Account, type AccountsSettings, type BrokerOffer, type Harness
} from '../shared/accounts.ts';
import { buildHarnessLaunch, codexTrustArguments, type Contribution } from '../launch/harness.ts';
import { effortArguments } from '../launch/effort.ts';
import { ensureHome, homeFolder, projectRouteProblem, providerIdOf, removeHomes, seedClaudeHome } from '../launch/homes.ts';
import { detectOllama, preflightOllama, type OllamaDetection, type OllamaFetch, type OllamaPreflight } from '../launch/ollama.ts';
import { PLUGIN_ID, checkEffort, listRoutes, pickAccount, routeQuota, type RouteFacts, type RouteQuota, type RouteRow } from '../routes/routes.ts';
import { QuotaReader, quotaUrlOf, type QuotaFetch } from '../quota/reader.ts';
import type { QuotaEvent } from '../quota/model.ts';
import { PoolService, type PoolsView } from '../pools/service.ts';
import { DATA_CLASSES, covers, type DataClass, type DataClassMode } from '../pools/model.ts';
import { POOL_INFO, isPoolProvider } from '../pools/providers.ts';
import { viewOf, emptyRecord } from '../quota/model.ts';
import {
  PLAN_HARNESSES, PLAN_INFO, PLAN_PROVIDERS, PLAN_VALUE, concurrencyOf, isPlanProvider, isPlanRegion, newPlanAccount, planHarnesses, planLaunchAccount, planOf,
  type PlanProvider, type PlanRegion
} from '../plans/plans.ts';
import { PlanPool, summarizeSkipped, type KeyState, type PlanMember } from '../plans/service.ts';

/**
 * The Accounts service: the launch contributor behind the launcher's "Model account" (and reasoning effort), the
 * orchestrator tools, and the plugin's settings page. Accounts live in the plugin's storage; keys live in the plugin's
 * secrets, written by the settings page and put into the agent's environment by CanvasTTY itself (`secretEnv`), so
 * this process sees a key only to check that it exists, where it was saved for, and its format.
 */

const STORAGE_KEY = 'accounts';
/** What this plugin shares with readers the person approved (services[].shares in the manifest). */
export const SHARED_METHODS = ['accounts.routes', 'accounts.quota'] as const;
/** CanvasTTY gives a shared read 5 s; key and Ollama checks get at most this, then the last listing answers. */
const SHARE_ROUTES_BUDGET_MS = 3_500;

/** The agent's own sign-in (the default login) when CanvasTTY saw its limit used up (`limit.exhausted`). */
export interface DefaultSignIn { provider: string; state: 'exhausted'; at: number; resetsAt: number | null; window: string | null }
/** CanvasTTY waits 5 s for a launch; the Ollama check gets most of it. */
const PREFLIGHT_BUDGET_MS = 3_500;

/** `canvastty.launch.prepare` as CanvasTTY ≥ core2/8 sends it. */
export interface LaunchContext {
  sessionId: string; provider: string; profile: string; role: string; cwd: string; restoring: boolean; resume: boolean;
  parentSessionId?: string;
  options: Record<string, unknown> | null;
  chosen?: boolean;
  environment?: { pluginId: string; kind: string } | null;
  /** CanvasTTY: a subagent in (or below) the folder the person chose for its orchestrator, as a real path. */
  trustedFolder?: string;
}

export type LaunchAnswer = Contribution | { refuse: { reason: string } } | null;

export type CheckResult =
  | { kind: 'ollama'; running: boolean; version: string | null; problem: OllamaDetection['problem']; models: Array<{ name: string; local: boolean; tools: boolean; size: string | null }>; model: { installed: boolean; tools: boolean } | null }
  | { kind: 'key'; ok: boolean; problem: string | null };

interface Stored { settings: AccountsSettings; keyOrigins: Record<string, string> }

const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ''; } };

/** The agent's own vendor API: its native auto reviewer is then the vendor's model, not a third party's. */
const VENDOR_ORIGINS: Partial<Record<Harness, string>> = { claude: 'https://api.anthropic.com', codex: 'https://api.openai.com' };
export const thirdPartyModel = (harness: Harness, baseUrl: string | null): boolean =>
  !baseUrl || VENDOR_ORIGINS[harness] !== originOf(baseUrl);
const refuse = (reason: string): LaunchAnswer => ({ refuse: { reason: reason.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) } });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One coding-plan pool as the page, readers and orchestrators see it (no keys, hosts only). */
export interface PlanSummary {
  plan: PlanProvider; label: string; agents: Harness[]; members: number; ready: number; busy: number;
  best: (RouteQuota & { accountId: string }) | null; trust: string;
  launchOptions: Record<string, Record<string, string | boolean>>;
}
export interface PlansView {
  providers: Array<{ provider: PlanProvider; label: string; regions: Array<{ region: PlanRegion; host: string; label: { en: string; ru: string } }> }>;
  /** Per plan account: its plan, region and the cards running on it now. */
  accounts: Record<string, { provider: PlanProvider; region: PlanRegion; host: string; running: number; concurrency: number }>;
}

export class AccountsService {
  settings: AccountsSettings;
  private keyOrigins: Record<string, string>;
  private readonly host: Host;
  private readonly dataDir: string;
  private readonly transport: OllamaFetch | undefined;
  private readonly checks = new Map<string, CheckResult | { error: string }>();
  /** Bumped whenever an account's check result is dropped (edited, removed, new key): a check started before it is stale. */
  private readonly checkEpochs = new Map<string, number>();

  /** The first read of the storage failed: nothing is known yet, so nothing may be shown as the accounts or saved over them. */
  private unread: boolean;
  private loading: Promise<void> | null = null;
  /** Saves and key bindings run one at a time, each against what the one before it persisted. */
  private writes: Promise<unknown> = Promise.resolve();
  /** Each account's quota, read from its provider on the reader's own schedule (quota/reader.ts). */
  readonly quota: QuotaReader;
  /** Subscription account pools: the person's own sign-ins, several per agent (pools/service.ts). */
  readonly pools: PoolService;
  /** Coding-plan pools (pool:glm, pool:minimax) over the plan accounts (plans/service.ts). */
  readonly plans: PlanPool;
  /** Default logins CanvasTTY saw used up, per agent, until their reset (memory only). */
  private readonly defaultSignIns = new Map<string, DefaultSignIn>();
  /** The last model account rows a shared read listed (answers a read whose checks run late). */
  private lastShared: { at: number; rows: Awaited<ReturnType<typeof listRoutes>> } | null = null;
  private readonly clock: () => number;

  /** `unread`: the storage could not be read at start (not the same as nothing saved yet). */
  constructor(options: { host: Host; dataDir: string; saved?: unknown; unread?: boolean; savedPools?: unknown; poolsUnread?: boolean; transport?: OllamaFetch; quotaFetch?: QuotaFetch; now?: () => number; random?: () => number }) {
    this.host = options.host;
    this.dataDir = options.dataDir;
    this.transport = options.transport;
    this.clock = options.now ?? Date.now;
    this.settings = loadSettings(undefined);
    this.keyOrigins = {};
    this.unread = options.unread === true;
    if (!this.unread) this.apply(options.saved);
    this.quota = new QuotaReader({
      dataDir: options.dataDir,
      // Nothing is read while the saved accounts are unknown.
      accounts: () => this.unread ? [] : this.settings.accounts,
      // Only a key saved for the account's current address is ever sent, and only to that address.
      key: async account => this.keyOrigins[account.id] === originOf(account.baseUrl) ? this.readKey(account) : null,
      log: (level, message) => this.host.log(level, message),
      onEvent: (accountId: string, event: QuotaEvent) => this.host.emit('quota', { accountId, kind: event.kind, at: event.at, note: event.note }),
      ...(options.quotaFetch ? { fetch: options.quotaFetch } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.random ? { random: options.random } : {})
    });
    this.pools = new PoolService({
      host: options.host, dataDir: options.dataDir, ...(options.poolsUnread ? { unread: true } : { saved: options.savedPools }),
      takenIds: () => new Set(this.settings.accounts.map(account => account.id)),
      ...(options.now ? { now: options.now } : {}), ...(options.random ? { random: options.random } : {})
    });
    this.plans = new PlanPool({ ...(options.now ? { now: options.now } : {}), cardEvents: () => this.pools.receivesCardEvents });
  }

  /** `canvastty.sessions.event`: pool sign-ins and plan accounts count their running cards. */
  sessionEvent(params: unknown): void {
    this.pools.sessionEvent(params);
    this.plans.sessionEvent(params);
  }

  private apply(value: unknown): void {
    const saved = value && typeof value === 'object' ? value as Partial<Stored> : {};
    this.settings = loadSettings(saved.settings);
    this.keyOrigins = {};
    for (const [id, origin] of Object.entries(saved.keyOrigins ?? {})) if (typeof origin === 'string' && this.find(id)) this.keyOrigins[id] = origin;
  }

  /**
   * Reads the saved accounts again when the first read failed; while they still cannot be read every request fails
   * instead of showing (and a save writing) an empty list over them.
   */
  async load(): Promise<void> {
    await this.pools.load();
    if (!this.unread) return;
    this.loading ??= this.host.callHost('storage.get', { key: STORAGE_KEY })
      .then(saved => { this.apply(saved); this.unread = false; })
      .finally(() => { this.loading = null; });
    try { await this.loading; } catch { throw new Error('The saved accounts could not be read; nothing was changed. Try again.'); }
  }

  private find(id: unknown): Account | undefined { return this.settings.accounts.find(account => account.id === id); }

  private forgetCheck(id: string): void {
    this.checks.delete(id);
    this.checkEpochs.set(id, (this.checkEpochs.get(id) ?? 0) + 1);
  }

  /** Writes `value`; the caller takes it into memory only once this resolved, so memory never shows what is not saved. */
  private async persist(value: Stored): Promise<void> {
    if (this.unread) throw new Error('The saved accounts could not be read; nothing was changed. Try again.');
    await this.host.callHost('storage.set', { key: STORAGE_KEY, value: value satisfies Stored });
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** The key of a keyed account, read in this process only to check it (the value is masked for agents by CanvasTTY). */
  private async readKey(account: Account): Promise<string | null> {
    let value: unknown;
    try { value = await this.host.callHost('secrets.get', { key: secretKeyOf(account.id) }); } catch { throw new Error('The plugin\'s secrets are unavailable.'); }
    return typeof value === 'string' && value ? value : null;
  }

  private async keyState(account: Account): Promise<'ok' | 'missing' | 'other-address'> {
    if (!(await this.readKey(account))) return 'missing';
    return this.keyOrigins[account.id] === originOf(account.baseUrl) ? 'ok' : 'other-address';
  }

  // ---- the settings page ----

  async state(): Promise<{ settings: AccountsSettings; keys: Record<string, 'ok' | 'missing' | 'other-address' | 'none'>; checks: Record<string, CheckResult | { error: string }>; presets: typeof PRESETS; quota: Record<string, RouteQuota & { readable: boolean; events: QuotaEvent[] }>; pools: PoolsView; plans: PlansView }> {
    // One secrets read per keyed account, all at once (MAX_ACCOUNTS stays under the transport's host-call cap).
    const { settings } = this;
    const states = await Promise.all(settings.accounts.map(account =>
      accountKeyed(account) ? this.keyState(account).catch(() => 'missing' as const) : Promise.resolve('none' as const)));
    const keys: Record<string, 'ok' | 'missing' | 'other-address' | 'none'> = {};
    settings.accounts.forEach((account, i) => { keys[account.id] = states[i]!; });
    const quota: Record<string, RouteQuota & { readable: boolean; events: QuotaEvent[] }> = {};
    for (const account of settings.accounts) {
      const view = this.quota.view(account);
      if (view) quota[account.id] = { ...routeQuota(view), readable: quotaUrlOf(account) !== null, events: this.quota.events(account.id).slice(-5) };
    }
    return { settings, keys, checks: Object.fromEntries(this.checks), presets: PRESETS, quota, pools: this.pools.view(), plans: this.plansView() };
  }

  private plansView(): PlansView {
    const accounts: PlansView['accounts'] = {};
    for (const account of this.settings.accounts) {
      const plan = planOf(account);
      if (plan) accounts[account.id] = { provider: plan.provider, region: plan.region, host: plan.host, running: this.plans.runningOn(account.id), concurrency: concurrencyOf(account) };
    }
    return {
      providers: PLAN_PROVIDERS.map(provider => ({ provider, label: PLAN_INFO[provider].label, regions: (['intl', 'cn'] as const).map(region => ({ region, ...PLAN_INFO[provider].regions[region] })) })),
      accounts
    };
  }

  /**
   * «Add subscription» for a coding plan: the account on the plan's own host for the region the person chose. The
   * data level is the person's answer, asked on add (`unset` is an answer, a missing one is not); the page then writes
   * the key into the plugin's secrets and binds it to this host (keyChanged).
   */
  async planAdd(params: unknown): Promise<{ id: string }> {
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    if (!isPlanProvider(values.provider)) throw new Error('Choose GLM Coding Plan or MiniMax Coding Plan.');
    if (!isPlanRegion(values.region)) throw new Error('Choose the plan\'s region.');
    if (values.trust === undefined) throw new Error('Choose how far you trust this account (or "Not set" to decide later).');
    const provider = values.provider;
    const label = typeof values.label === 'string' && values.label.trim() ? values.label.trim()
      : `${PLAN_INFO[provider].label} ${this.plans.members(this.settings.accounts, provider).length + 1}`;
    const taken = new Set([...this.settings.accounts.map(account => account.id), ...this.pools.settings.accounts.map(account => account.id)]);
    const account = newPlanAccount({
      id: newAccountId(`${provider}-${label}`, taken), provider, region: values.region, label, trust: values.trust as Account['trust'],
      ...(values.concurrency !== undefined ? { concurrency: values.concurrency as number } : {}), ...(values.brokerable === true ? { brokerable: true } : {})
    });
    await this.save({ version: 1, accounts: [...this.settings.accounts, account] });
    return { id: account.id };
  }

  async save(value: unknown): Promise<{ saved: true }> {
    const next = validateSettings(value);
    const clash = next.accounts.find(account => this.pools.find(account.id));
    if (clash) throw new Error(`${clash.id} is already the name of a pool account; rename the model account.`);
    return this.serialized(async () => {
      const keyOrigins = { ...this.keyOrigins };
      const removed: string[] = [];
      const changed: string[] = [];
      for (const account of this.settings.accounts) {
        const { id } = account;
        const kept = next.accounts.find(entry => entry.id === id);
        if (!kept) {
          delete keyOrigins[id];
          removed.push(id);
        } else if (originOf(kept.baseUrl) !== originOf(account.baseUrl) || kept.preset !== account.preset) {
          // A key is never sent to an address it was not saved for: the person saves it again.
          delete keyOrigins[id];
          changed.push(id);
        } else if (kept.model !== account.model) changed.push(id);
      }
      // Saved first: a failed write leaves memory (and the removed accounts' homes) as they were.
      await this.persist({ settings: next, keyOrigins });
      this.settings = next;
      this.keyOrigins = keyOrigins;
      for (const id of [...removed, ...changed]) this.forgetCheck(id);
      for (const id of removed) this.quota.forget(id);
      for (const id of removed) this.plans.forget(id);
      for (const id of removed) await removeHomes(this.dataDir, id).catch(() => undefined);
      return { saved: true as const };
    });
  }

  /** The page saved or removed a key: bind it to the account's address as it is now. */
  async keyChanged(accountId: unknown): Promise<null> {
    return this.serialized(async () => {
      const account = this.find(accountId);
      if (!account) throw new Error('No such account.');
      const keyOrigins = { ...this.keyOrigins };
      if (await this.readKey(account)) keyOrigins[account.id] = originOf(account.baseUrl);
      else delete keyOrigins[account.id];
      // The key itself already changed: its old check result is stale whether or not the binding is saved.
      this.forgetCheck(account.id);
      await this.persist({ settings: this.settings, keyOrigins });
      this.keyOrigins = keyOrigins;
      // Another key may be another plan: what was read with the old one no longer applies.
      this.quota.forget(account.id);
      return null;
    });
  }

  /**
   * «Проверить»: an Ollama account on this computer lists the server's models; an account with a key gets a format
   * check of the saved key only. Nothing is sent to a paid API.
   */
  async check(accountId: unknown): Promise<CheckResult | { error: string }> {
    const account = this.find(accountId);
    if (!account) throw new Error('No such account.');
    const epoch = this.checkEpochs.get(account.id) ?? 0;
    let result: CheckResult | { error: string };
    try {
      const shape = ollamaShapeOf(account);
      if (shape === 'local' || shape === 'cloud-local') {
        const detection = await detectOllama(account.baseUrl, this.transport);
        const models = detection.models.filter(model => shape === 'local' ? model.source === 'local' : true)
          .map(model => ({ name: model.name, local: model.source === 'local', tools: model.agentReady, size: model.parameterSize }));
        const wanted = account.model.replace(/:local$/u, '');
        const listed = detection.models.find(model => model.name === wanted || model.name === `${wanted}:latest`);
        result = { kind: 'ollama', running: detection.running, version: detection.version, problem: detection.problem, models,
          model: shape === 'local' && detection.running ? { installed: !!listed && listed.source === 'local', tools: !!listed?.agentReady } : null };
      } else {
        const key = await this.readKey(account);
        const problem = !key ? 'No key is saved.'
          : this.keyOrigins[account.id] !== originOf(account.baseUrl) ? 'The key was saved for another address; save it again.'
            : apiKeyProblem(key) ? apiKeyProblemMessage(apiKeyProblem(key)!)
              : key.length < 16 ? 'The key is shorter than any provider\'s keys; copy it again.' : null;
        result = { kind: 'key', ok: problem === null, problem };
      }
    } catch (error) {
      result = { error: errorText(error) };
    }
    // Kept for the page only if the account is still the one that was checked.
    if ((this.checkEpochs.get(account.id) ?? 0) === epoch && this.find(account.id)) this.checks.set(account.id, result);
    return result;
  }

  /** «Прочитать сейчас»: one read of the account's quota (bounded like every read: not twice within 30 s). */
  async readQuota(accountId: unknown): Promise<{ read: boolean }> {
    const account = this.find(accountId);
    if (!account) throw new Error('No such account.');
    const url = quotaUrlOf(account);
    if (!url) return { read: false };
    await this.quota.read(account, url);
    return { read: true };
  }

  // ---- the settings page: pools ----

  poolAdd(params: unknown): ReturnType<PoolService['add']> { return this.pools.add(params); }
  poolSignIn(accountId: unknown): ReturnType<PoolService['signIn']> { return this.pools.signIn(accountId); }
  poolUpdate(params: unknown): ReturnType<PoolService['update']> { return this.pools.update(params); }
  poolRemove(accountId: unknown): ReturnType<PoolService['remove']> { return this.pools.remove(accountId); }
  poolCheck(accountId: unknown): ReturnType<PoolService['check']> { return this.pools.check(accountId); }

  // ---- CanvasTTY: the launcher list and the launch ----

  /** `canvastty.launch.options`: the accounts the person allowed for this agent. */
  launchOptions(provider: unknown): Record<string, Array<{ value: string; label: string }>> {
    const harness = HARNESSES.find(entry => entry === provider);
    const models = harness ? this.settings.accounts.filter(account => this.runsOn(account, harness))
      .map(account => ({ value: account.id, label: `${account.label} · ${account.model}` })) : [];
    // Coding-plan pools for Claude Code and OpenCode, then the agent's own subscription sign-ins (pools).
    const plans = harness && PLAN_HARNESSES.includes(harness) ? PLAN_PROVIDERS.flatMap(plan => {
      const members = this.plans.members(this.settings.accounts, plan);
      return members.length ? [{ value: `${PLAN_VALUE}${plan}`, label: `${PLAN_INFO[plan].label} pool · the account with the most room (${members.length})` }] : [];
    }) : [];
    return { account: [...models, ...plans, ...this.pools.launchOptions(provider)] };
  }

  /** May this account run this agent? A coding-plan account runs Claude Code and OpenCode on the plan's endpoint too. */
  private runsOn(account: Account, harness: Harness): boolean {
    return (planOf(account) ? planHarnesses(account) : account.agents).includes(harness) && harnessSupport(harness, planLaunchAccount(account, harness)).ok;
  }

  /** `canvastty.launch.prepare`. */
  async prepare(context: LaunchContext): Promise<LaunchAnswer> {
    if (context.chosen === false) return null;
    const options = context.options ?? {};
    const accountId = typeof options.account === 'string' && options.account ? options.account : 'none';
    const effort = typeof options.effort === 'string' && options.effort ? options.effort : 'default';
    // Only a person's launch may pre-answer the folder question; a subagent's options come from a model.
    const trust = options.trustFolder === true && context.role !== 'subagent';
    let effortArgs: string[];
    try { effortArgs = effortArguments(context.provider, effort); } catch (error) { return refuse(errorText(error)); }

    const planPool = accountId.startsWith(PLAN_VALUE) ? accountId.slice(PLAN_VALUE.length) : null;
    if (planPool !== null && isPlanProvider(planPool)) return this.preparePlan(context, planPool, effortArgs, trust);
    if (this.pools.handles(accountId)) return this.pools.prepare(context, accountId, effort, trust);
    if (accountId === 'none') {
      // The agent's own sign-in: only effort, and Codex's per-run folder trust (never written to ~/.codex).
      const args = [...effortArgs, ...(trust && context.provider === 'codex' ? codexTrustArguments([context.cwd]) : [])];
      return args.length ? { env: {}, secretEnv: {}, args, files: [] } : null;
    }
    const account = this.find(accountId);
    if (!account) return refuse(`Model account ${accountId.slice(0, 40)} no longer exists; choose another one in the launcher.`);
    if (planOf(account)) {
      // A pick handed out by pick_account is this launch: it does not count against itself.
      this.plans.consume(account.id);
      const active = this.plans.active(account.id, context.sessionId);
      if (context.role === 'subagent' && !context.restoring && !context.resume && active >= concurrencyOf(account)) {
        const plan = planOf(account)!.provider;
        return refuse(`${account.label} already runs ${active} card(s), the most the person allows at once; use pool:${plan} to let the pool choose.`);
      }
    }
    return this.prepareAccount(context, account, effortArgs, trust);
  }

  /**
   * A launch on `pool:glm` / `pool:minimax`: the plan account with the most headroom (exact quota first, then
   * estimated, unknown; never one without a key, used up or at the person's card limit). A restored or resumed card
   * keeps the account it ran on while that one still exists.
   */
  private async preparePlan(context: LaunchContext, plan: PlanProvider, effortArgs: string[], trust: boolean): Promise<LaunchAnswer> {
    const label = PLAN_INFO[plan].label;
    const harness = HARNESSES.find(entry => entry === context.provider);
    if (!harness || !PLAN_HARNESSES.includes(harness)) return refuse(`The ${label} pool runs Claude Code and OpenCode.`);
    const members = this.plans.members(this.settings.accounts, plan);
    if (!members.length) return refuse(`There are no ${label} accounts; add one in the Accounts settings (Subscription accounts).`);
    const earlier = (context.restoring || context.resume) ? this.plans.earlier(context.sessionId) : undefined;
    const kept = earlier ? members.find(member => member.id === earlier) : undefined;
    let account: Account | undefined = kept?.account;
    if (!account) {
      const { ranked, skipped } = await this.rankPlans(members, { except: context.sessionId });
      account = ranked[0]?.account.account;
      if (!account) return refuse(`No ${label} account can take this card now: ${summarizeSkipped(skipped)}.`);
    }
    return this.prepareAccount(context, account, effortArgs, trust);
  }

  private async rankPlans(members: readonly PlanMember[], request: { dataClass?: DataClass; mode?: DataClassMode; except?: string } = {}): Promise<ReturnType<PlanPool['rank']>> {
    const keys = new Map<string, KeyState>();
    await Promise.all(members.map(async member => { keys.set(member.id, await this.keyState(member.account).catch(() => 'missing' as const)); }));
    return this.plans.rank(members, member => ({ key: keys.get(member.id) ?? 'missing', quota: this.quota.view(member.account) ?? viewOf(emptyRecord(), this.clock()) }), request);
  }

  private async prepareAccount(context: LaunchContext, saved: Account, effortArgs: string[], trust: boolean): Promise<LaunchAnswer> {
    let account = saved;
    // A subagent's options come from a model (an orchestrator or the Assistant's Auto), so it never runs on OpenRouter;
    // an agent the person starts themselves still may.
    if (context.role === 'subagent' && decisionsOnlyAccount(account)) return refuse(`${account.label} cannot run a subagent: ${DECISIONS_ONLY_REASON}.`);
    const harness = HARNESSES.find(entry => entry === context.provider) as Harness | undefined;
    const plan = planOf(account);
    if (!harness || !(plan ? planHarnesses(account) : account.agents).includes(harness)) return refuse(`${account.label} is not set up for ${(HARNESS_LABELS as Record<string, string>)[context.provider] ?? context.provider}.`);
    // A coding plan: Claude Code and OpenCode on the plan's Anthropic endpoint, on the host the key was saved for.
    if (plan) account = planLaunchAccount(saved, harness);
    const support = harnessSupport(harness, account);
    if (!support.ok) return refuse(support.reason === 'responses-api' ? 'Codex needs an endpoint with the OpenAI Responses API.' : `${HARNESS_LABELS[harness]} cannot run on this account.`);
    if (context.environment && context.environment.kind !== 'worktree') {
      return refuse(`A model account runs agents on this computer (a worktree is fine), not in "${context.environment.kind}".`);
    }

    const protocol = protocolOf(account);
    const shape = ollamaShapeOf(account);
    const keyed = accountKeyed(account);
    let keyValue: string | undefined;
    if (keyed) {
      const key = await this.readKey(account).catch(() => null);
      if (!key) return refuse(`${account.label} has no key; save one in the Accounts settings.`);
      if (this.keyOrigins[account.id] !== originOf(saved.baseUrl) || originOf(account.baseUrl) !== originOf(saved.baseUrl)) return refuse(`The key of ${account.label} was saved for another address; save it again in the Accounts settings.`);
      const problem = apiKeyProblem(key);
      if (problem) return refuse(`${apiKeyProblemMessage(problem)} (${account.label})`);
      // L27: OpenCode substitutes {env:…} into its JSON as raw text; a key that needs escaping would print the config.
      const substitution = harness === 'opencode' ? envSubstitutionProblem(key) : null;
      if (substitution) return refuse(openCodeKeyRefusal(substitution));
      if (harness === 'kimi') keyValue = key;
      if (harness === 'claude') {
        const route = await projectRouteProblem(context.cwd);
        if (route) return refuse(route);
      }
    }

    let preflight: OllamaPreflight | null = null;
    if (shape === 'local' || shape === 'cloud-local') {
      let timer: NodeJS.Timeout | undefined;
      try {
        preflight = await Promise.race([
          preflightOllama({ baseUrl: account.baseUrl, shape, model: account.model, harness }, this.transport),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Ollama did not answer in time.')), PREFLIGHT_BUDGET_MS); })
        ]);
      } catch (error) {
        return refuse(errorText(error));
      } finally { if (timer) clearTimeout(timer); }
      if (preflight.note) this.host.log('info', `${account.label}: ${preflight.note}`);
    }
    let model = account.model;
    if (shape === 'cloud-direct') {
      const wire = ollamaWireModel(shape, account.model);
      if (!wire.ok) return refuse(`Model ${account.model} is not an Ollama Cloud name.`);
      model = wire.model;
    } else if (preflight) model = preflight.wireModel;

    let home: string | undefined;
    try {
      if (harness === 'claude' || harness === 'codex') home = await ensureHome(homeFolder(this.dataDir, harness, account.id));
      // The account's own config home: the folder the person trusted for this launch, or (for a subagent) the one they
      // chose for its orchestrator, which CanvasTTY hands over as trustedFolder.
      const folders = [...(trust ? [context.cwd] : []), ...(typeof context.trustedFolder === 'string' ? [context.trustedFolder] : [])];
      if (harness === 'claude') await seedClaudeHome(home!, folders);
    } catch (error) {
      return refuse(`The account's agent home could not be prepared: ${errorText(error)}`);
    }
    let contribution: Contribution;
    try {
      contribution = buildHarnessLaunch({
        harness, protocol, ...(shape ? { ollamaShape: shape } : {}), baseUrl: account.baseUrl, model, ...(account.smallModel ? { smallModel: account.smallModel } : {}),
        ...(keyed ? { secretKey: secretKeyOf(account.id) } : {}), ...(keyValue ? { keyValue } : {}),
        providerId: providerIdOf(account.id), ...(home ? { home } : {}), contextWindow: preflight?.contextWindow ?? null,
        disableWebSearch: preflight?.cloudFeatures === true || shape === 'cloud-direct',
        ...(trust && harness === 'codex' ? { trustedFolders: [context.cwd] } : {})
      });
    } catch (error) {
      return refuse(errorText(error));
    }
    contribution.args.push(...effortArgs);
    // A weak model's own auto classifier is not a safety boundary: CanvasTTY runs "auto" as accept-edits for it.
    if (thirdPartyModel(harness, account.baseUrl)) contribution.thirdPartyModel = true;
    this.quota.used(saved);
    if (plan) this.plans.started(context.sessionId, saved.id);
    return contribution;
  }

  // ---- what CanvasTTY tells every limits:read plugin ----

  /**
   * `canvastty.activity` `limit.exhausted`. CanvasTTY's event is provider-wide: the agent's own sign-in (the default
   * login, `accountId: "default"`) has a window at 100 %. That login is not a model account or a pool account, so
   * nothing of ours rests: it is remembered until its reset and shown to orchestrators and readers (list_routes,
   * accounts.routes, accounts.quota), so they prefer the pool or an account. When an event names one of this plugin's
   * accounts (a pool account or a model account), that account rests until the reset.
   */
  activity(params: unknown): boolean {
    const event = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    if (event.type !== 'limit.exhausted' || typeof event.provider !== 'string' || !/^[a-z0-9-]{1,40}$/u.test(event.provider)) return false;
    const now = this.clock();
    const at = typeof event.at === 'number' && Number.isFinite(event.at) ? Math.min(event.at, now) : now;
    const resetsAt = typeof event.resetAt === 'number' && Number.isFinite(event.resetAt) && event.resetAt > now ? event.resetAt : null;
    const accountId = typeof event.accountId === 'string' ? event.accountId : 'default';
    if (accountId === 'default') {
      const window = event.window && typeof event.window === 'object' ? event.window as Record<string, unknown> : {};
      const label = typeof window.label === 'string' && window.label.length <= 40 ? window.label : null;
      this.defaultSignIns.set(event.provider, { provider: event.provider, state: 'exhausted', at, resetsAt, window: label });
      this.host.emit('quota', { accountId: 'default', provider: event.provider, kind: 'exhausted', at, note: `${event.provider}'s own sign-in: ${label ?? 'a window'} used up` });
      return true;
    }
    if (this.pools.noteLimit(accountId, event.provider, at, resetsAt)) return true;
    const account = this.find(accountId);
    if (!account || !(planOf(account) ? planHarnesses(account) : account.agents).includes(event.provider as Harness)) return false;
    this.quota.noteLimit(account, { source: 'host-activity', at, windows: [], exhausted: { until: resetsAt, code: 'limit' } });
    return true;
  }

  /** Default logins still used up now (a passed reset ends it). */
  private exhaustedDefaults(provider?: string): DefaultSignIn[] {
    const now = this.clock();
    for (const [key, entry] of this.defaultSignIns) if (entry.resetsAt !== null && entry.resetsAt <= now) this.defaultSignIns.delete(key);
    return [...this.defaultSignIns.values()].filter(entry => !provider || entry.provider === provider);
  }

  // ---- shared reads (CanvasTTY's canvastty.shares.read, for readers the person approved) ----

  /**
   * One shared read. CanvasTTY routes it only for a pair the person approved, checks the answer for secrets and sizes,
   * and gives this method `{ caller: { pluginId }, method, params }`. No keys, key states beyond "no key", homes or paths
   * are in an answer: rows name hosts, account ids and the person's labels.
   *
   * - `accounts.routes { provider? }`: the model account routes and pool accounts as list_routes lists them (quota
   *   included), the pools (`pool:<agent>`: members, free ones, the best free one's quota) and the default logins
   *   CanvasTTY saw used up.
   * - `accounts.quota { provider? }`: quota only (no key or Ollama checks): each model account's and pool account's
   *   quota, the measured usage of each pool home (last 5 h), the pools and the used-up default logins.
   */
  async shareRead(params: unknown): Promise<unknown> {
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const method = values.method;
    const inner = values.params && typeof values.params === 'object' && !Array.isArray(values.params) ? values.params as Record<string, unknown> : {};
    const provider = typeof inner.provider === 'string' && /^[a-z0-9-]{1,32}$/u.test(inner.provider) ? inner.provider : undefined;
    const at = this.clock();
    if (method === 'accounts.routes') {
      this.pools.demand(provider);
      this.quota.demand(this.settings.accounts.filter(account => !provider || (planOf(account) ? planHarnesses(account) : account.agents).includes(provider as Harness)));
      const listing = listRoutes(this.settings.accounts, this.facts(), provider ? { provider } : {}).then(rows => { this.lastShared = { at: this.clock(), rows }; return rows; });
      listing.catch(() => undefined);
      const rows = await Promise.race([listing, new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), SHARE_ROUTES_BUDGET_MS); timer.unref?.(); })]).catch(() => null)
        ?? (this.lastShared ? this.lastShared.rows.filter(row => !provider || row.provider === provider) : []);
      return {
        at,
        routes: [...this.planRows(rows), ...this.pools.routes({ ...(provider ? { provider } : {}), effort: 'default' })].map(row => shareRow(row)),
        pools: this.pools.summaries(provider ? { provider } : {}),
        plans: await this.planSummaries(provider),
        defaultSignIns: this.exhaustedDefaults(provider)
      };
    }
    if (method === 'accounts.quota') {
      void this.pools.refreshUsage();
      return {
        at,
        accounts: this.settings.accounts.filter(account => !provider || (planOf(account) ? planHarnesses(account) : account.agents).includes(provider as Harness)).map(account => {
          const view = this.quota.view(account);
          const plan = planOf(account);
          if (plan) {
            return { accountId: account.id, account: account.label, kind: 'subscription', plan: plan.provider, agents: planHarnesses(account), running: this.plans.runningOn(account.id), concurrency: concurrencyOf(account), trust: account.trust ?? 'unset', quota: routeQuota(view ?? viewOf(emptyRecord(), at)) };
          }
          return { accountId: account.id, account: account.label, kind: 'model-account', agents: [...account.agents], ...(view ? { quota: routeQuota(view) } : {}) };
        }),
        poolAccounts: this.pools.view().providers.flatMap(entry => entry.accounts).filter(member => !provider || member.provider === provider).map(member => {
          const usage = this.pools.usageOf(member.id);
          return {
            accountId: member.id, account: member.label, kind: 'subscription', agent: member.provider, signIn: member.signIn, running: member.running, trust: member.trust, quota: member.quota,
            ...(usage ? { usage5h: { input: usage.input, output: usage.output, cached: usage.cached, events: usage.events, sessions: usage.sessions, measuredAt: new Date(usage.at).toISOString(), complete: usage.complete } } : {})
          };
        }),
        pools: this.pools.summaries(provider ? { provider } : {}),
        plans: await this.planSummaries(provider),
        defaultSignIns: this.exhaustedDefaults(provider)
      };
    }
    throw new Error('This plugin shares accounts.routes and accounts.quota only.');
  }

  // ---- brokered requests (CanvasTTY B6) ----

  /**
   * `canvastty.broker.offer`: the accounts the person marked for other extensions, whose key is saved for the
   * account's current address. CanvasTTY reads the key itself (`secretKey`) and asks this again before every request,
   * so unmarking an account, removing its key or changing its address ends it at once. Never a key.
   */
  brokerOffer(): BrokerOffer[] {
    if (this.unread) return [];
    return this.settings.accounts.flatMap(account => {
      if (this.keyOrigins[account.id] !== originOf(account.baseUrl)) return [];
      // A coding plan is a flat-rate subscription; another account is when its plan quota can be read.
      const offer = brokerOfferOf(account, planOf(account) !== null || quotaUrlOf(account) !== null);
      return offer ? [offer] : [];
    });
  }

  /**
   * `canvastty.broker.admit { ref, caller, model }`: this plugin's quota decides. A marked account whose plan is used
   * up (by a read at 100 % or a limit error) is refused until it resets; otherwise its quota is read again when old.
   */
  brokerAdmit(params: unknown): { ok: true } | { ok: false; reason: string } {
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const account = this.find(values.ref);
    const offer = account && this.keyOrigins[account.id] === originOf(account.baseUrl) ? brokerOfferOf(account, false) : null;
    if (!account || !offer) return { ok: false, reason: 'This account is not offered to other extensions.' };
    if (typeof values.model !== 'string' || !offer.models.includes(values.model)) return { ok: false, reason: `${account.label} runs ${account.model} only.` };
    const view = this.quota.view(account);
    if (view?.state === 'exhausted') {
      const caller = values.caller && typeof values.caller === 'object' ? String((values.caller as { pluginId?: unknown }).pluginId ?? '').slice(0, 80) : '';
      this.host.log('info', `${account.id}: a brokered request${caller ? ` from ${caller}` : ''} was refused, the plan is used up.`);
      return { ok: false, reason: `${account.label}: plan quota used up${view.resetsAt ? ` until ${new Date(view.resetsAt).toISOString()}` : ''}.` };
    }
    this.quota.demand([account]);
    return { ok: true };
  }

  /** `canvastty.broker.settle`: a request through the account ended; the quota learns it was used. */
  brokerSettle(params: unknown): null {
    const values = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const account = this.find(values.ref);
    if (!account) return null;
    if (values.status === 'ok') this.quota.used(account);
    // A refusal by the provider may be the plan's limit: read the quota again (bounded by the reader's own schedule).
    else if (values.httpStatus === 429 || values.httpStatus === 403) this.quota.demand([account]);
    return null;
  }

  // ---- orchestrator tools ----

  private facts(): RouteFacts {
    const detections = new Map<string, Promise<OllamaDetection>>();
    return {
      key: account => this.keyState(account).catch(() => 'missing' as const),
      quota: account => this.quota.view(account),
      ollama: baseUrl => {
        if (!detections.has(baseUrl)) detections.set(baseUrl, detectOllama(baseUrl, this.transport, 1_500));
        return detections.get(baseUrl)!;
      }
    };
  }

  /**
   * Coding-plan rows of a listing: a ready row whose account is at the person's card limit is `busy`; with a task's
   * data class, an account trusted below it is `data-class` in strict mode or keeps a note in warn mode.
   */
  private planRows(rows: RouteRow[], request: { dataClass?: DataClass; mode?: DataClassMode } = {}): RouteRow[] {
    const mode: DataClassMode = request.dataClass ? request.mode ?? 'warn' : 'off';
    return rows.map(row => {
      if (!row.plan || row.state !== 'ready') return row;
      const account = this.find(row.accountId);
      if (!account) return row;
      const active = this.plans.active(account.id);
      if (active >= concurrencyOf(account)) {
        const { launchOptions: _launch, ...rest } = row;
        return { ...rest, state: 'busy' as const, reason: `${active} cards already run on it (the person allows ${concurrencyOf(account)} at once)` };
      }
      if (request.dataClass && mode !== 'off' && !covers(account.trust ?? 'unset', request.dataClass)) {
        const level = account.trust && account.trust !== 'unset' ? `trusted up to ${account.trust}` : 'the person has not set its data level';
        if (mode === 'strict') {
          const { launchOptions: _launch, ...rest } = row;
          return { ...rest, state: 'data-class' as const, reason: `${level}; this task is ${request.dataClass}` };
        }
        return { ...row, reason: `below this task's class ${request.dataClass} (${level}); the person chose to be warned only` };
      }
      return row;
    });
  }

  /** Each coding-plan pool with members: free ones, the best one's quota and the lowest trust (for readers). */
  private async planSummaries(provider?: string): Promise<PlanSummary[]> {
    if (provider && !(PLAN_HARNESSES as readonly string[]).includes(provider)) return [];
    const order: Record<string, number> = { unset: -1, D0: 0, D1: 1, D2: 2, D3: 3 };
    const out: PlanSummary[] = [];
    for (const plan of PLAN_PROVIDERS) {
      const members = this.plans.members(this.settings.accounts, plan);
      if (!members.length) continue;
      const { ranked } = await this.rankPlans(members);
      const best = ranked[0];
      const trust = ranked.reduce<string | null>((low, entry) => low === null || order[entry.account.trust]! < order[low]! ? entry.account.trust : low, null) ?? 'unset';
      out.push({
        plan, label: `${PLAN_INFO[plan].label} pool`, agents: [...PLAN_HARNESSES], members: members.length, ready: ranked.length,
        busy: members.filter(member => this.plans.active(member.id) > 0).length,
        best: best ? { ...routeQuota(best.facts.quota), accountId: best.account.id } : null, trust,
        launchOptions: { [PLUGIN_ID]: { account: `${PLAN_VALUE}${plan}`, effort: 'default', trustFolder: false } }
      });
    }
    return out;
  }

  /** The plan account with the most room for this agent now, across the person's plans; reserved for a minute. */
  private async pickPlan(harness: Harness, request: { effort: string; model?: string; dataClass?: DataClass; mode?: DataClassMode }): Promise<{ accountId: string; account: string; plan: PlanProvider; model: string; launchOptions: Record<string, Record<string, string | boolean>>; why: string; quota: RouteQuota; trust: string } | null> {
    if (request.effort !== 'default' && harness !== 'claude') return null;
    const members = this.plans.members(this.settings.accounts).filter(member => !request.model || member.account.model.toLowerCase().includes(request.model.toLowerCase()));
    if (!members.length) return null;
    const { ranked, skipped } = await this.rankPlans(members, { ...(request.dataClass ? { dataClass: request.dataClass } : {}), ...(request.mode ? { mode: request.mode } : {}) });
    const chosen = ranked[0];
    if (!chosen) throw new Error(`No coding-plan account is free: ${summarizeSkipped(skipped)}.`);
    this.plans.reserve(chosen.account.id);
    const quota = routeQuota(chosen.facts.quota);
    const room = quota.remainingPercent === null ? `quota ${quota.state}` : `${Math.round((100 - quota.remainingPercent) * 10) / 10}% used, ${quota.remainingPercent}% left (${quota.confidence})`;
    return {
      accountId: chosen.account.id, account: chosen.account.label, plan: chosen.account.provider, model: chosen.account.account.model, trust: chosen.account.trust, quota,
      launchOptions: { [PLUGIN_ID]: { account: chosen.account.id, effort: request.effort, trustFolder: false } },
      why: `${HARNESS_LABELS[harness]} on the ${PLAN_INFO[chosen.account.provider].label} account ${chosen.account.label}: ${room}, the most room among ${ranked.length} free of ${members.length}`
        + (chosen.note ? `; ${chosen.note}` : '') + (skipped.length ? `; skipped ${skipped.map(entry => `${entry.account.label} (${entry.reason})`).join('; ')}` : '') + '.'
    };
  }

  async tool(name: string, input: Record<string, unknown>): Promise<{ content: unknown; isError?: boolean }> {
    const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
    const provider = text(input.provider, 32);
    const model = text(input.model, 100);
    const effort = text(input.effort, 20);
    const dataClass = (DATA_CLASSES as readonly unknown[]).includes(input.dataClass) ? input.dataClass as DataClass : undefined;
    const mode = (['strict', 'warn', 'off'] as const).find(entry => entry === input.dataClassMode) as DataClassMode | undefined;
    if (input.dataClass !== undefined && !dataClass) return { content: 'dataClass must be D0, D1, D2 or D3.', isError: true };
    if (name === 'list_routes' || name === 'pick_account') this.pools.demand(provider);
    // Accounts asked about are read again in the background when their quota data is old.
    if (name === 'list_routes' || name === 'pick_account') this.quota.demand(this.settings.accounts.filter(account => !provider || (planOf(account) ? planHarnesses(account) : account.agents).includes(provider as Harness)));
    if (name === 'list_routes') {
      let routes;
      try {
        const checked = checkEffort(effort);
        routes = [
          ...this.planRows(await listRoutes(this.settings.accounts, this.facts(), { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }), { ...(dataClass ? { dataClass } : {}), ...(mode ? { mode } : {}) }),
          // Pool accounts run the agent's own models: a model filter leaves them out.
          ...(model ? [] : this.pools.routes({ ...(provider ? { provider } : {}), effort: checked, ...(dataClass ? { dataClass } : {}), ...(mode ? { mode } : {}) }))
        ];
      } catch (error) {
        return { content: errorText(error), isError: true };
      }
      return { content: {
        routes,
        pools: `Subscription pools (kind "subscription") are the person's own sign-ins, several per agent, and their coding plans (GLM, MiniMax: rows with "plan"). Pass launchOptions {"${PLUGIN_ID}":{"account":"pool:<agent>"}} to let the pool choose the account with the most room at launch, or a row's launchOptions for that account. One card per sign-in at a time; a coding-plan account takes several cards at once up to the person's limit, and its pool is {"${PLUGIN_ID}":{"account":"pool:glm"}} or "pool:minimax" for Claude Code and OpenCode.`,
        signIn: 'Each agent\'s own CLI sign-in is not listed here: spawn_agent without launchOptions uses it, and CanvasTTY reports when it does not work.',
        ...(this.exhaustedDefaults(provider).length ? { usedUpSignIns: this.exhaustedDefaults(provider).map(entry => `${entry.provider}'s own sign-in: ${entry.window ?? 'a window'} used up${entry.resetsAt ? ` until ${new Date(entry.resetsAt).toISOString()}` : ''}; prefer its pool or an account`) } : {}),
        howTo: 'Pass a ready route\'s launchOptions to spawn_agent unchanged (same provider).'
      } };
    }
    if (name === 'pick_account') {
      if (!provider) return { content: 'Give the agent in `provider` (claude, codex, grok, opencode, qwen or kimi).', isError: true };
      // The agent's own subscription sign-ins first (flat-rate), unless the caller asks for model accounts only.
      const source = input.source === 'accounts' || input.source === 'pool' ? input.source : 'any';
      let poolError: string | null = null;
      if (source !== 'accounts' && isPoolProvider(provider)) {
        try {
          const picked = this.pools.pick(provider, { effort: checkEffort(effort), ...(dataClass ? { dataClass } : {}), ...(mode ? { mode } : {}) });
          if (picked) return { content: { ...picked, kind: 'subscription', spawn: { provider, launchOptions: picked.launchOptions } } };
        } catch (error) { poolError = errorText(error); }
      }
      // Then the person's coding plans (flat-rate keys), the account with the most room across them.
      const harness = HARNESSES.find(entry => entry === provider);
      if (source !== 'accounts' && harness && PLAN_HARNESSES.includes(harness)) {
        try {
          const picked = await this.pickPlan(harness, { effort: checkEffort(effort), ...(model ? { model } : {}), ...(dataClass ? { dataClass } : {}), ...(mode ? { mode } : {}) });
          if (picked) return { content: { ...picked, kind: 'subscription', spawn: { provider, launchOptions: picked.launchOptions } } };
        } catch (error) { poolError = poolError ? `${poolError} ${errorText(error)}` : errorText(error); }
      }
      if (source === 'pool') return { content: poolError ?? `There is no ${(POOL_INFO as Record<string, { label: string }>)[provider]?.label ?? provider} pool.`, isError: true };
      if (poolError && !(HARNESSES as readonly string[]).includes(provider)) return { content: poolError, isError: true };
      try {
        // Model accounts only: coding-plan accounts were the subscription step above.
        const pick = await pickAccount(this.settings.accounts.filter(account => !planOf(account)), this.facts(), { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        return { content: { ...pick, spawn: { provider, launchOptions: pick.launchOptions } } };
      } catch (error) {
        return { content: poolError ? `${poolError} ${errorText(error)}` : errorText(error), isError: true };
      }
    }
    return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
  }
}

/** A route row as shared: only the fields readers route on (no key states beyond the row's state, no paths). */
function shareRow(row: object): Record<string, unknown> {
  const keep = ['provider', 'agent', 'accountId', 'account', 'kind', 'plan', 'model', 'endpoint', 'state', 'reason', 'launchOptions', 'quota', 'trust'];
  return Object.fromEntries(Object.entries(row).filter(([key]) => keep.includes(key)));
}

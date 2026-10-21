import type { Host } from '../rpc.ts';
import { apiKeyProblem, apiKeyProblemMessage, envSubstitutionProblem, openCodeKeyRefusal } from '../shared/apiKeyHygiene.ts';
import {
  DECISIONS_ONLY_REASON, HARNESS_LABELS, HARNESSES, PRESETS, accountKeyed, decisionsOnlyAccount, harnessSupport, loadSettings, ollamaShapeOf,
  ollamaWireModel, protocolOf, secretKeyOf, validateSettings, type Account, type AccountsSettings, type Harness
} from '../shared/accounts.ts';
import { buildHarnessLaunch, codexTrustArguments, type Contribution } from '../launch/harness.ts';
import { effortArguments } from '../launch/effort.ts';
import { ensureHome, homeFolder, projectRouteProblem, providerIdOf, removeHomes, seedClaudeHome } from '../launch/homes.ts';
import { detectOllama, preflightOllama, type OllamaDetection, type OllamaFetch, type OllamaPreflight } from '../launch/ollama.ts';
import { PLUGIN_ID, checkEffort, listRoutes, pickAccount, routeQuota, type RouteFacts, type RouteQuota } from '../routes/routes.ts';
import { QuotaReader, quotaUrlOf, type QuotaFetch } from '../quota/reader.ts';
import type { QuotaEvent } from '../quota/model.ts';
import { PoolService, type PoolsView } from '../pools/service.ts';
import { DATA_CLASSES, type DataClass, type DataClassMode } from '../pools/model.ts';
import { POOL_INFO, isPoolProvider } from '../pools/providers.ts';

/**
 * The Accounts service: the launch contributor behind the launcher's "Model account" (and reasoning effort), the
 * orchestrator tools, and the plugin's settings page. Accounts live in the plugin's storage; keys live in the plugin's
 * secrets, written by the settings page and put into the agent's environment by CanvasTTY itself (`secretEnv`), so
 * this process sees a key only to check that it exists, where it was saved for, and its format.
 */

const STORAGE_KEY = 'accounts';
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

  /** `unread`: the storage could not be read at start (not the same as nothing saved yet). */
  constructor(options: { host: Host; dataDir: string; saved?: unknown; unread?: boolean; savedPools?: unknown; poolsUnread?: boolean; transport?: OllamaFetch; quotaFetch?: QuotaFetch; now?: () => number; random?: () => number }) {
    this.host = options.host;
    this.dataDir = options.dataDir;
    this.transport = options.transport;
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

  async state(): Promise<{ settings: AccountsSettings; keys: Record<string, 'ok' | 'missing' | 'other-address' | 'none'>; checks: Record<string, CheckResult | { error: string }>; presets: typeof PRESETS; quota: Record<string, RouteQuota & { readable: boolean; events: QuotaEvent[] }>; pools: PoolsView }> {
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
    return { settings, keys, checks: Object.fromEntries(this.checks), presets: PRESETS, quota, pools: this.pools.view() };
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
    const models = harness ? this.settings.accounts.filter(account => account.agents.includes(harness) && harnessSupport(harness, account).ok)
      .map(account => ({ value: account.id, label: `${account.label} · ${account.model}` })) : [];
    // The agent's own subscription sign-ins (pools) after the model accounts.
    return { account: [...models, ...this.pools.launchOptions(provider)] };
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

    if (this.pools.handles(accountId)) return this.pools.prepare(context, accountId, effort, trust);
    if (accountId === 'none') {
      // The agent's own sign-in: only effort, and Codex's per-run folder trust (never written to ~/.codex).
      const args = [...effortArgs, ...(trust && context.provider === 'codex' ? codexTrustArguments([context.cwd]) : [])];
      return args.length ? { env: {}, secretEnv: {}, args, files: [] } : null;
    }
    const account = this.find(accountId);
    if (!account) return refuse(`Model account ${accountId.slice(0, 40)} no longer exists; choose another one in the launcher.`);
    // A subagent's options come from a model (an orchestrator or the Assistant's Auto), so it never runs on OpenRouter;
    // an agent the person starts themselves still may.
    if (context.role === 'subagent' && decisionsOnlyAccount(account)) return refuse(`${account.label} cannot run a subagent: ${DECISIONS_ONLY_REASON}.`);
    const harness = HARNESSES.find(entry => entry === context.provider) as Harness | undefined;
    if (!harness || !account.agents.includes(harness)) return refuse(`${account.label} is not set up for ${(HARNESS_LABELS as Record<string, string>)[context.provider] ?? context.provider}.`);
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
      if (this.keyOrigins[account.id] !== originOf(account.baseUrl)) return refuse(`The key of ${account.label} was saved for another address; save it again in the Accounts settings.`);
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
        harness, protocol, ...(shape ? { ollamaShape: shape } : {}), baseUrl: account.baseUrl, model,
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
    this.quota.used(account);
    return contribution;
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
    if (name === 'list_routes' || name === 'pick_account') this.quota.demand(this.settings.accounts.filter(account => !provider || account.agents.includes(provider as Harness)));
    if (name === 'list_routes') {
      let routes;
      try {
        const checked = checkEffort(effort);
        routes = [
          ...await listRoutes(this.settings.accounts, this.facts(), { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }),
          // Pool accounts run the agent's own models: a model filter leaves them out.
          ...(model ? [] : this.pools.routes({ ...(provider ? { provider } : {}), effort: checked, ...(dataClass ? { dataClass } : {}), ...(mode ? { mode } : {}) }))
        ];
      } catch (error) {
        return { content: errorText(error), isError: true };
      }
      return { content: {
        routes,
        pools: `Subscription pools (kind "subscription") are the person's own sign-ins, several per agent. Pass launchOptions {"${PLUGIN_ID}":{"account":"pool:<agent>"}} to let the pool choose the account with the most room at launch, or a row's launchOptions for that account. One card per sign-in at a time.`,
        signIn: 'Each agent\'s own CLI sign-in is not listed here: spawn_agent without launchOptions uses it, and CanvasTTY reports when it does not work.',
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
      if (source === 'pool') return { content: poolError ?? `There is no ${(POOL_INFO as Record<string, { label: string }>)[provider]?.label ?? provider} pool.`, isError: true };
      if (poolError && !(HARNESSES as readonly string[]).includes(provider)) return { content: poolError, isError: true };
      try {
        const pick = await pickAccount(this.settings.accounts, this.facts(), { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
        return { content: { ...pick, spawn: { provider, launchOptions: pick.launchOptions } } };
      } catch (error) {
        return { content: poolError ? `${poolError} ${errorText(error)}` : errorText(error), isError: true };
      }
    }
    return { content: `Unknown tool ${name.slice(0, 40)}.`, isError: true };
  }
}

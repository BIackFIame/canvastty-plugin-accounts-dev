/**
 * Subscription account pools inside the Accounts service: several sign-ins per agent CLI (30 Grok accounts, a few
 * Claude ones), each in its own CLI home under `<dataDir>/pools/<id>`, signed in once by the CLI's own sign-in in a
 * card the person sees (this plugin never sees a password or a token), with each account's quota read by CanvasTTY
 * (`limits.get {provider, home}`) and a launch on `pool:<agent>` given the account with the most headroom.
 *
 * Nothing here reads a credential: a home is "signed in" when the CLI's credential file exists (stat only), when its
 * Claude Code account marker is present, or when CanvasTTY's own limits read says so. Nothing here reaches the network:
 * quota comes from the host. Homes stay on this computer (refresh tokens rotate: a copied sign-in breaks the other).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Host } from '../rpc.ts';
import { ensureHome, seedClaudeHome } from '../launch/homes.ts';
import { codexTrustArguments } from '../launch/harness.ts';
import { effortArguments } from '../launch/effort.ts';
import { emptyRecord, loadRecord, nextReadAt, observe, readFailed, used, viewOf, type QuotaEvent, type QuotaRecord, type QuotaWindow } from '../quota/model.ts';
import { PLUGIN_ID, routeQuota, type RouteQuota, type RouteRow } from '../routes/routes.ts';
import { DATA_CLASSES, MAX_POOL_ACCOUNTS, covers, loadPools, newPoolId, rankPool, validatePoolAccount, type DataClass, type DataClassMode, type MemberFacts, type PoolAccount, type PoolSettings, type PoolTrust, type SignIn } from './model.ts';
import { NOT_POOLED, POOL_INFO, POOL_PROVIDERS, isPoolProvider, type PoolProvider } from './providers.ts';

const STORAGE_KEY = 'pools';
export const POOL_STATE_FILE = 'pools-state.json';
/** CanvasTTY's own bound: limits are read for at most this many account homes per plugin (PluginLimits). */
export const CORE_HOME_LIMIT = 32;
const TICK_MS = 15_000;
/** CanvasTTY reads a home at most once per 3 minutes; asking sooner only returns its cache. */
const MIN_READ_MS = 3 * 60_000;
const MAX_CONCURRENT_READS = 2;
/** After "no such host method" or no permission, ask again this much later (a CanvasTTY update may add it). */
const LIMITS_RETRY_MS = 30 * 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const RESERVATION_MS = 60_000;
const WRITE_DELAY_MS = 500;
/** Measured token usage per pool home (CanvasTTY's usage.summary with homes), read at most this often. */
const USAGE_EVERY_MS = 10 * 60_000;
/** usage.summary takes at most 8 homes per call. */
const USAGE_HOMES_PER_CALL = 8;
/** CanvasTTY measures usage for these agents' homes (Grok keeps no per-request usage). */
const USAGE_PROVIDERS = new Set<string>(['claude', 'codex', 'kimi']);
const USAGE_WINDOW_MS = 5 * 3_600_000;

export const POOL_VALUE = 'pool:';
export const MEMBER_VALUE = 'sub:';
export const SIGN_IN_VALUE = 'signin:';

export interface PoolLaunchContext {
  sessionId: string; provider: string; role: string; cwd: string; restoring: boolean; resume: boolean;
  environment?: { pluginId: string; kind: string } | null; trustedFolder?: string;
}
export type PoolAnswer = { env: Record<string, string>; secretEnv: Record<string, string>; args: string[]; files: Array<{ relPath: string; content: string }> } | { refuse: { reason: string } };

interface MemberState {
  signIn: SignIn;
  signInCheckedAt: number | null;
  lastUsedAt: number | null;
  quota: QuotaRecord;
  /** Why CanvasTTY cannot read this home's limits (`unsupported`, `home-limit`), or null. */
  limitsNote: string | null;
}

export interface PoolMemberView {
  id: string; provider: PoolProvider; label: string; trust: PoolTrust; signIn: SignIn; running: number; lastUsedAt: number | null;
  quota: RouteQuota; limitsNote: string | null; events: QuotaEvent[]; signingIn: boolean;
}
/** Tokens a pool home used in the last 5 h, as CanvasTTY measured them from the CLI's own usage log. */
export interface HomeUsage { input: number; output: number; cached: number; events: number; sessions: number; since: number; at: number; complete: boolean }

/** One pool as shared with readers (no keys, no homes, no paths): how many members, how many free, the best one's quota. */
export interface PoolSummary {
  agent: PoolProvider; label: string; members: number; ready: number; busy: number;
  best: (RouteQuota & { accountId: string }) | null;
  /** The lowest data level the person trusts a free member with (`unset` when one is not set). */
  trust: PoolTrust;
  launchOptions: Record<string, Record<string, string | boolean>>;
}

export interface PoolsView {
  providers: Array<{ provider: PoolProvider; label: string; signInHint: { en: string; ru: string }; accounts: PoolMemberView[] }>;
  notPooled: Record<string, string>;
  limits: 'yes' | 'no' | 'unknown';
  /** false: CanvasTTY sends no card events to this plugin, so a running card cannot be counted. */
  cardEvents: boolean;
  homeLimit: { limit: number; over: boolean };
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const refuse = (reason: string): PoolAnswer => ({ refuse: { reason: reason.replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 240) } });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const emptyMember = (): MemberState => ({ signIn: 'unknown', signInCheckedAt: null, lastUsedAt: null, quota: emptyRecord(), limitsNote: null });

/** Does the home hold a sign-in? Existence of the CLI's credential file only; Claude's account marker as a yes/no. */
export async function probeSignIn(provider: PoolProvider, home: string): Promise<'signed-in' | 'signed-out'> {
  const info = POOL_INFO[provider];
  for (const file of info.credentialFiles) {
    try { if ((await stat(join(home, file))).isFile()) return 'signed-in'; } catch { /* absent */ }
  }
  if (info.credentialFolder) {
    try { if ((await readdir(join(home, info.credentialFolder))).length > 0) return 'signed-in'; } catch { /* absent */ }
  }
  if (provider === 'claude') {
    // macOS keeps the token in the Keychain; Claude Code records the signed-in account in its own .claude.json. Only
    // whether the entry exists is looked at; nothing from it is kept or shown.
    try {
      const text = await readFile(join(home, '.claude.json'), 'utf8');
      if (text.length < 4_000_000) {
        const parsed = record(JSON.parse(text));
        if (parsed.oauthAccount && typeof parsed.oauthAccount === 'object') return 'signed-in';
      }
    } catch { /* absent or unreadable */ }
  }
  return 'signed-out';
}

/** One provider entry of a `limits.get` answer, as an observation or the reason there is none. */
export function limitsObservation(provider: PoolProvider, answer: unknown):
  | { kind: 'ok'; at: number; windows: QuotaWindow[] }
  | { kind: 'signed-out' | 'expired' | 'unsupported' | 'failed'; reason: string } {
  const snapshot = record(record(answer).snapshot);
  const entry = (Array.isArray(snapshot.providers) ? snapshot.providers : []).map(record).find(item => item.provider === provider);
  if (!entry) return { kind: 'failed', reason: 'CanvasTTY gave no limits for this agent' };
  const reason = typeof entry.reason === 'string' ? entry.reason : '';
  if (entry.state === 'unavailable' || entry.state === 'stale') {
    if (reason === 'not-authenticated') return { kind: 'signed-out', reason: 'not signed in' };
    if (reason === 'session-expired') return { kind: 'expired', reason: 'the sign-in expired' };
    if (reason === 'unsupported-protocol') return { kind: 'unsupported', reason: 'CanvasTTY cannot read this agent\'s quota for an account yet' };
    return { kind: 'failed', reason: reason ? `CanvasTTY could not read it (${reason.slice(0, 40)})` : 'CanvasTTY could not read it' };
  }
  if (entry.state !== 'available') return { kind: 'failed', reason: 'CanvasTTY gave an unknown limits state' };
  const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const windows: QuotaWindow[] = [];
  for (const raw of (Array.isArray(entry.windows) ? entry.windows : []).slice(0, 8).map(record)) {
    const id = typeof raw.id === 'string' ? raw.id.slice(0, 40) : null;
    if (!id) continue;
    const minutes = num(raw.windowMinutes);
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 30)
      : minutes === null ? id : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
    // Only the account's main bucket limits model calls; another bucket (one model's own) never blocks the account.
    windows.push({ id: `${provider}:${id}`, label, usedPercent: num(raw.usedPercent), used: num(raw.used), limit: num(raw.limit), windowMinutes: minutes, resetsAt: num(raw.resetsAt), models: raw.isDefaultBucket !== false });
  }
  return { kind: 'ok', at: num(entry.fetchedAt) ?? num(snapshot.fetchedAt) ?? Date.now(), windows };
}

export class PoolService {
  settings: PoolSettings = { version: 1, accounts: [] };
  private readonly host: Host;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly takenIds: () => ReadonlySet<string>;
  private readonly members = new Map<string, MemberState>();
  /** Session id -> pool account: the cards running on each sign-in (kept across restarts so a card resumes on its account). */
  private readonly sessions = new Map<string, string>();
  /** Sessions whose card is running now (released on exit or close). */
  private readonly running = new Set<string>();
  private readonly reservations = new Map<string, number[]>();
  private readonly signIns = new Map<string, { accountId: string; expiresAt: number }>();
  /** Sign-in cards: session id -> account. */
  private readonly signInCards = new Map<string, string>();
  private readonly due = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private limits: { state: 'yes' | 'no' | 'unknown'; retryAt: number } = { state: 'unknown', retryAt: 0 };
  /** Measured usage per member home (memory only), and whether this CanvasTTY measures it. */
  private readonly usage = new Map<string, HomeUsage>();
  private usageState: { state: 'yes' | 'no' | 'unknown'; at: number } = { state: 'unknown', at: 0 };
  private usageRun: Promise<void> | null = null;
  /** Card events arrive (sessions.subscribe answered): only then can a running card be counted until it ends. */
  private cardEvents = false;
  private unread = false;
  private loading: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(options: { host: Host; dataDir: string; saved?: unknown; unread?: boolean; takenIds?: () => ReadonlySet<string>; now?: () => number; random?: () => number }) {
    this.host = options.host;
    this.dataDir = options.dataDir;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.takenIds = options.takenIds ?? (() => new Set());
    this.unread = options.unread === true;
    if (!this.unread) this.settings = loadPools(options.saved);
    this.file = join(options.dataDir, POOL_STATE_FILE);
    try {
      const saved = record(JSON.parse(readFileSync(this.file, 'utf8')));
      if (saved.version === 1) {
        for (const [id, value] of Object.entries(record(saved.members)).slice(0, MAX_POOL_ACCOUNTS)) {
          const raw = record(value);
          const quota = loadRecord(raw.quota);
          const signIn = (['signed-in', 'signed-out', 'expired', 'unknown'] as const).find(entry => entry === raw.signIn) ?? 'unknown';
          const num = (key: string): number | null => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] as number : null;
          this.members.set(id, { signIn, signInCheckedAt: num('signInCheckedAt'), lastUsedAt: num('lastUsedAt'), quota: quota ?? emptyRecord(), limitsNote: typeof raw.limitsNote === 'string' ? raw.limitsNote.slice(0, 160) : null });
        }
        for (const [session, id] of Object.entries(record(saved.sessions)).slice(0, 4_096)) if (typeof id === 'string' && session.length <= 200) this.sessions.set(session, id);
      }
    } catch { /* nothing saved yet */ }
  }

  homeOf(id: string): string { return join(this.dataDir, 'pools', id); }
  /** CanvasTTY sends card events (sessions.subscribe answered), so a running card can be counted until it ends. */
  get receivesCardEvents(): boolean { return this.cardEvents; }
  find(id: unknown): PoolAccount | undefined { return this.settings.accounts.find(account => account.id === id); }
  private member(id: string): MemberState {
    let state = this.members.get(id);
    if (!state) { state = emptyMember(); this.members.set(id, state); }
    return state;
  }

  async load(): Promise<void> {
    if (!this.unread) return;
    this.loading ??= this.host.callHost('storage.get', { key: STORAGE_KEY })
      .then(saved => { this.settings = loadPools(saved); this.unread = false; })
      .finally(() => { this.loading = null; });
    try { await this.loading; } catch { throw new Error('The saved pool accounts could not be read; nothing was changed. Try again.'); }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async persist(next: PoolSettings): Promise<void> {
    if (this.unread) throw new Error('The saved pool accounts could not be read; nothing was changed. Try again.');
    await this.host.callHost('storage.set', { key: STORAGE_KEY, value: next });
    this.settings = next;
  }

  // ---- start, sessions, limits notifications ----

  /** Subscribes to card events (the one-card-per-sign-in rule and sign-in endings) and reads quotas on a timer. */
  async start(): Promise<void> {
    try {
      const answer = record(await this.host.callHost('sessions.subscribe', {}));
      this.cardEvents = true;
      this.sessionsKnown(answer.sessions);
    } catch (error) {
      this.host.log('warn', `pools: card events are not available (${errorText(error).slice(0, 120)}); the one-card-per-sign-in rule cannot be kept.`);
    }
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
      this.timer.unref?.();
    }
    void this.refreshSignIns();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.allSettled([...this.inFlight.values()]);
    await this.flush();
  }

  /** The cards running now (from sessions.subscribe): everything else this plugin remembered as running has ended. */
  sessionsKnown(list: unknown): void {
    const live = new Set<string>();
    for (const entry of Array.isArray(list) ? list.map(record) : []) {
      const session = record(entry);
      const id = typeof session.id === 'string' ? session.id : null;
      if (id && session.exitCode === null && session.status !== 'exited') live.add(id);
    }
    this.running.clear();
    for (const id of this.sessions.keys()) if (live.has(id)) this.running.add(id);
  }

  /** `canvastty.sessions.event`. */
  sessionEvent(params: unknown): void {
    const event = record(params);
    const session = record(event.session);
    const id = typeof session.id === 'string' ? session.id : null;
    if (!id || (event.type !== 'exited' && event.type !== 'closed')) return;
    this.running.delete(id);
    if (event.type === 'closed') { this.sessions.delete(id); this.save(); }
    const signInFor = this.signInCards.get(id);
    if (signInFor) {
      this.signInCards.delete(id);
      // The sign-in card ended: what the home holds now, and its quota as soon as CanvasTTY can read it.
      void this.check(signInFor).catch(() => undefined);
    }
    this.host.emit('pools', { changed: true });
  }

  /** `canvastty.limits.changed` for one of this plugin's homes. */
  limitsChanged(params: unknown): void {
    const values = record(params);
    if (typeof values.home !== 'string' || !isPoolProvider(values.provider)) return;
    const account = this.settings.accounts.find(entry => entry.provider === values.provider && this.homeOf(entry.id) === values.home);
    if (account) this.applyLimits(account, values);
  }

  /**
   * CanvasTTY saw a limit used up for a named pool account (`canvastty.activity` `limit.exhausted` with that account):
   * it rests until the reset. The core's provider-wide event (the default login) names no pool account and is handled
   * by the service (`defaultSignIns`).
   */
  noteLimit(accountId: string, provider: string, at: number, resetAt: number | null): boolean {
    const account = this.find(accountId);
    if (!account || account.provider !== provider) return false;
    const state = this.member(account.id);
    const observed = observe(state.quota, { source: 'host-activity', at, windows: [], exhausted: { until: resetAt, code: 'limit' } }, this.now());
    state.quota = observed.record;
    for (const event of observed.events) this.host.emit('quota', { accountId: account.id, kind: event.kind, at: event.at, note: event.note });
    this.save();
    this.host.emit('pools', { changed: true });
    return true;
  }

  /** Every pool with at least one member: members, free ones, the best free one's quota and the lowest trust. */
  summaries(filter: { provider?: string } = {}): PoolSummary[] {
    const out: PoolSummary[] = [];
    const rank: Record<PoolTrust, number> = { unset: -1, D0: 0, D1: 1, D2: 2, D3: 3 };
    for (const provider of POOL_PROVIDERS) {
      if (filter.provider && filter.provider !== provider) continue;
      const members = this.settings.accounts.filter(account => account.provider === provider);
      if (!members.length) continue;
      const { ranked } = rankPool(members, account => this.facts(account));
      const best = ranked[0];
      const busy = members.filter(account => this.facts(account).active > 0).length;
      const trust = ranked.reduce<PoolTrust | null>((low, entry) => low === null || rank[entry.account.trust] < rank[low] ? entry.account.trust : low, null) ?? 'unset';
      out.push({
        agent: provider, label: `${POOL_INFO[provider].label} pool`, members: members.length, ready: ranked.length, busy,
        best: best ? { ...routeQuota(best.facts.quota), accountId: best.account.id } : null, trust,
        launchOptions: { [PLUGIN_ID]: { account: `${POOL_VALUE}${provider}`, effort: 'default', trustFolder: false } }
      });
    }
    return out;
  }

  /** The last measured usage of a member's home (null: not measured). */
  usageOf(accountId: string): HomeUsage | null { return this.usage.get(accountId) ?? null; }

  /**
   * Measured usage of the pool homes (CanvasTTY's `usage.summary` with `homes`, permission usage:read and
   * launch:contribute): the last 5 h per home, at most every 10 min, 8 homes per call, at most CanvasTTY's 32 homes per
   * plugin. Counts only; an older core answers "unknown method" and nothing is measured.
   */
  refreshUsage(force = false): Promise<void> {
    const now = this.now();
    if (this.usageRun) return this.usageRun;
    if (!force && now - this.usageState.at < USAGE_EVERY_MS) return Promise.resolve();
    if (!force && this.usageState.state === 'no' && now - this.usageState.at < LIMITS_RETRY_MS) return Promise.resolve();
    const members = this.settings.accounts.filter(account => USAGE_PROVIDERS.has(account.provider) && this.member(account.id).signIn !== 'signed-out').slice(0, CORE_HOME_LIMIT);
    this.usageState = { ...this.usageState, at: now };
    if (!members.length) return Promise.resolve();
    this.usageRun = (async () => {
      const since = now - USAGE_WINDOW_MS;
      for (let i = 0; i < members.length; i += USAGE_HOMES_PER_CALL) {
        const batch = members.slice(i, i + USAGE_HOMES_PER_CALL);
        let answer: Record<string, unknown>;
        try {
          answer = record(await this.host.callHost('usage.summary', { since, groupBy: ['home'], homes: batch.map(account => ({ provider: account.provider, home: this.homeOf(account.id) })) }));
        } catch (error) {
          if (/unknown (host )?method|does not have the (usage:read|launch:contribute) permission/iu.test(errorText(error))) { this.usageState = { state: 'no', at: now }; return; }
          continue;
        }
        if (!Array.isArray(answer.rows)) continue;
        this.usageState = { state: 'yes', at: now };
        const complete = record(answer.coverage).complete !== false;
        const counts = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
        batch.forEach(account => this.usage.set(account.id, { input: 0, output: 0, cached: 0, events: 0, sessions: 0, since, at: now, complete }));
        for (const row of answer.rows.map(record)) {
          const index = typeof row.home === 'number' && Number.isInteger(row.home) ? row.home : -1;
          const account = batch[index];
          if (!account) continue;
          this.usage.set(account.id, { input: counts(row.input), output: counts(row.output), cached: counts(row.cached), events: counts(row.events), sessions: counts(row.sessions), since, at: now, complete });
        }
      }
    })().finally(() => { this.usageRun = null; });
    return this.usageRun;
  }

  // ---- the settings page ----

  view(): PoolsView {
    const homes = this.settings.accounts.filter(account => POOL_INFO[account.provider].limits).length;
    return {
      providers: POOL_PROVIDERS.map(provider => ({
        provider, label: POOL_INFO[provider].label, signInHint: POOL_INFO[provider].signIn,
        accounts: this.settings.accounts.filter(account => account.provider === provider).map(account => this.memberView(account))
      })),
      notPooled: { ...NOT_POOLED },
      limits: this.limits.state,
      cardEvents: this.cardEvents,
      homeLimit: { limit: CORE_HOME_LIMIT, over: homes > CORE_HOME_LIMIT }
    };
  }

  private memberView(account: PoolAccount): PoolMemberView {
    const state = this.member(account.id);
    return {
      id: account.id, provider: account.provider, label: account.label, trust: account.trust, signIn: state.signIn, running: this.runningOn(account.id),
      lastUsedAt: state.lastUsedAt, quota: routeQuota(viewOf(state.quota, this.now())), limitsNote: state.limitsNote, events: state.quota.events.slice(-5),
      signingIn: [...this.signInCards.values()].includes(account.id)
    };
  }

  /**
   * «Add account»: the account, its own empty home, and a card with the CLI's own sign-in for it. The data level is
   * the person's answer, asked on add: `unset` is a valid answer ("decide later"), a missing one is not.
   */
  async add(params: unknown): Promise<{ id: string; signIn: { sessionId: string } | { error: string } }> {
    const values = record(params);
    if (!isPoolProvider(values.provider)) throw new Error(values.provider && typeof values.provider === 'string' && NOT_POOLED[values.provider] ? NOT_POOLED[values.provider]! : 'Choose Claude Code, Codex, Grok or Kimi.');
    if (values.trust === undefined) throw new Error('Choose how far you trust this account (or "Not set" to decide later).');
    const provider = values.provider;
    const id = await this.serialized(async () => {
      if (this.settings.accounts.length >= MAX_POOL_ACCOUNTS) throw new Error(`The pool list is full (${MAX_POOL_ACCOUNTS} accounts is the storage bound).`);
      const label = typeof values.label === 'string' && values.label.trim() ? values.label.trim() : `${POOL_INFO[provider].label} ${this.settings.accounts.filter(entry => entry.provider === provider).length + 1}`;
      const taken = new Set([...this.takenIds(), ...this.settings.accounts.map(entry => entry.id)]);
      const account = validatePoolAccount({ id: newPoolId(provider, label, taken), provider, label, trust: values.trust, addedAt: this.now() });
      // The home first: an account is never saved without the folder its sign-in goes into.
      await ensureHome(this.homeOf(account.id));
      try { await this.persist({ version: 1, accounts: [...this.settings.accounts, account] }); } catch (error) { await rm(this.homeOf(account.id), { recursive: true, force: true }); throw error; }
      this.members.set(account.id, { ...emptyMember(), signIn: 'signed-out', signInCheckedAt: this.now() });
      this.save();
      return account.id;
    });
    let signIn: { sessionId: string } | { error: string };
    try { signIn = await this.signIn(id); } catch (error) { signIn = { error: errorText(error) }; }
    return { id, signIn };
  }

  /** «Sign in»: a card running the CLI in the account's home; the CLI's own first run (or /login) signs it in. */
  async signIn(accountId: unknown): Promise<{ sessionId: string }> {
    const account = this.find(accountId);
    if (!account) throw new Error('No such pool account.');
    if (this.runningOn(account.id) > 0) throw new Error(`A card already runs on ${account.label}; close it before signing in again.`);
    const home = await ensureHome(this.homeOf(account.id));
    const nonce = randomBytes(12).toString('hex');
    for (const [key, entry] of this.signIns) if (entry.expiresAt <= this.now() || entry.accountId === account.id) this.signIns.delete(key);
    this.signIns.set(nonce, { accountId: account.id, expiresAt: this.now() + SIGN_IN_TTL_MS });
    const answer = record(await this.host.callHost('sessions.create', {
      provider: account.provider, cwd: homedir() || home, profile: 'normal', title: `Sign in · ${account.label}`.slice(0, 80),
      launchOptions: { [PLUGIN_ID]: { account: `${SIGN_IN_VALUE}${account.id}:${nonce}`, effort: 'default', trustFolder: false } }
    }));
    if (typeof answer.sessionId !== 'string') throw new Error('CanvasTTY did not open the sign-in card.');
    this.signInCards.set(answer.sessionId, account.id);
    return { sessionId: answer.sessionId };
  }

  async update(params: unknown): Promise<{ saved: true }> {
    const values = record(params);
    return this.serialized(async () => {
      const account = this.find(values.id);
      if (!account) throw new Error('No such pool account.');
      const next = validatePoolAccount({ ...account, ...(values.label !== undefined ? { label: values.label } : {}), ...(values.trust !== undefined ? { trust: values.trust } : {}) });
      await this.persist({ version: 1, accounts: this.settings.accounts.map(entry => entry.id === next.id ? next : entry) });
      return { saved: true as const };
    });
  }

  /** «Remove»: the account and its whole home (its sign-in with it). Refused while a card runs on it. */
  async remove(accountId: unknown): Promise<{ removed: true }> {
    return this.serialized(async () => {
      const account = this.find(accountId);
      if (!account) throw new Error('No such pool account.');
      if (this.runningOn(account.id) > 0) throw new Error(`A card still runs on ${account.label}; close it first.`);
      await this.persist({ version: 1, accounts: this.settings.accounts.filter(entry => entry.id !== account.id) });
      this.members.delete(account.id);
      this.due.delete(account.id);
      this.reservations.delete(account.id);
      for (const [session, id] of this.sessions) if (id === account.id) this.sessions.delete(session);
      for (const [key, entry] of this.signIns) if (entry.accountId === account.id) this.signIns.delete(key);
      await rm(this.homeOf(account.id), { recursive: true, force: true });
      this.save();
      return { removed: true as const };
    });
  }

  /** «Check»: the home's sign-in now, and its quota (bounded like every read). */
  async check(accountId: unknown): Promise<PoolMemberView> {
    const account = this.find(accountId);
    if (!account) throw new Error('No such pool account.');
    await this.probe(account);
    if (POOL_INFO[account.provider].limits) await this.read(account, true);
    return this.memberView(account);
  }

  private async probe(account: PoolAccount): Promise<void> {
    const found = await probeSignIn(account.provider, this.homeOf(account.id));
    const state = this.member(account.id);
    // A read that said "expired" stays until the home changes (a fresh sign-in) or a read succeeds.
    if (!(found === 'signed-in' && state.signIn === 'expired')) state.signIn = found;
    state.signInCheckedAt = this.now();
    if (found === 'signed-in') this.due.set(account.id, this.now());
    this.save();
  }

  private async refreshSignIns(): Promise<void> {
    for (const account of this.settings.accounts) await this.probe(account).catch(() => undefined);
  }

  // ---- quota ----

  private runningOn(accountId: string): number {
    let count = 0;
    for (const session of this.running) if (this.sessions.get(session) === accountId) count++;
    return count;
  }

  private reserved(accountId: string): number {
    const now = this.now();
    const list = (this.reservations.get(accountId) ?? []).filter(until => until > now);
    if (list.length) this.reservations.set(accountId, list); else this.reservations.delete(accountId);
    return list.length;
  }

  facts(account: PoolAccount, except?: string): MemberFacts {
    const state = this.member(account.id);
    let active = this.reserved(account.id);
    for (const session of this.running) if (session !== except && this.sessions.get(session) === account.id) active++;
    return { signIn: state.signIn, quota: viewOf(state.quota, this.now()), active, lastUsedAt: state.lastUsedAt };
  }

  /** Reads the homes that are due (the timer calls it; tests call it directly). */
  async tick(): Promise<void> {
    void this.refreshUsage().catch(() => undefined);
    if (this.limits.state === 'no' && this.now() < this.limits.retryAt) return;
    const waiting: Promise<void>[] = [];
    for (const account of this.settings.accounts) {
      if (this.inFlight.size >= MAX_CONCURRENT_READS) break;
      if (!POOL_INFO[account.provider].limits || this.inFlight.has(account.id)) continue;
      const state = this.member(account.id);
      if (state.signIn === 'signed-out') continue;
      const last = Math.max(state.quota.observedAt ?? 0, state.quota.lastAttemptAt ?? 0);
      const at = this.due.get(account.id) ?? Math.max(nextReadAt({ record: state.quota, now: this.now(), random: this.random() }), last + MIN_READ_MS);
      if (!this.due.has(account.id)) this.due.set(account.id, at);
      if (at > this.now()) continue;
      waiting.push(this.read(account, false));
    }
    await Promise.allSettled(waiting);
  }

  /** Accounts asked about now (list_routes, pick_account): read the ones whose data is old, in the background. */
  demand(provider?: string): void {
    for (const account of this.settings.accounts) {
      if (provider && account.provider !== provider) continue;
      const quota = this.member(account.id).quota;
      if (this.now() - Math.max(quota.observedAt ?? 0, quota.lastAttemptAt ?? 0) > 10 * 60_000 && quota.failures === 0) this.due.set(account.id, this.now());
    }
    void this.tick();
  }

  private read(account: PoolAccount, now: boolean): Promise<void> {
    const running = this.inFlight.get(account.id);
    if (running) return running;
    const state = this.member(account.id);
    const last = Math.max(state.quota.observedAt ?? 0, state.quota.lastAttemptAt ?? 0);
    if (!now && this.now() - last < MIN_READ_MS) return Promise.resolve();
    // Codex's limits read starts its app-server in the home, which may refresh the sign-in: never next to a running card.
    if (POOL_INFO[account.provider].limitsReadRefreshes && this.runningOn(account.id) > 0) {
      this.due.set(account.id, this.now() + MIN_READ_MS);
      return Promise.resolve();
    }
    const run = this.request(account).finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, run);
    return run;
  }

  private async request(account: PoolAccount): Promise<void> {
    const state = this.member(account.id);
    const started = this.now();
    let answer: unknown;
    try {
      answer = await this.host.callHost('limits.get', { provider: account.provider, home: this.homeOf(account.id) });
      this.limits = { state: 'yes', retryAt: 0 };
    } catch (error) {
      const text = errorText(error);
      if (/unknown (host )?method/iu.test(text) || /does not have the (limits:read|launch:contribute) permission/iu.test(text)) {
        this.limits = { state: 'no', retryAt: started + LIMITS_RETRY_MS };
        state.limitsNote = /permission/iu.test(text) ? 'CanvasTTY lets this plugin read quotas only with the limits:read permission' : 'this CanvasTTY cannot read quotas for account homes yet';
      } else if (/at most \d+ account homes/iu.test(text)) {
        state.limitsNote = `CanvasTTY reads quotas for at most ${CORE_HOME_LIMIT} accounts per plugin; this one stays unknown`;
      } else {
        state.limitsNote = null;
      }
      state.quota = readFailed(state.quota, state.limitsNote ?? 'CanvasTTY could not read the quota', started);
      this.due.set(account.id, Math.max(nextReadAt({ record: state.quota, now: started, random: this.random() }), started + (this.limits.state === 'no' ? LIMITS_RETRY_MS : MIN_READ_MS)));
      this.save();
      return;
    }
    this.applyLimits(account, answer);
  }

  private applyLimits(account: PoolAccount, answer: unknown): void {
    const state = this.member(account.id);
    const now = this.now();
    const result = limitsObservation(account.provider, answer);
    if (result.kind === 'ok') {
      state.signIn = 'signed-in';
      state.signInCheckedAt = now;
      state.limitsNote = null;
      if (state.quota.observedAt !== null && result.at <= state.quota.observedAt) {
        // CanvasTTY's cache: nothing new since the last read.
        state.quota = { ...state.quota, lastAttemptAt: now };
      } else {
        const observed = observe(state.quota, { source: 'core-limits', at: result.at, windows: result.windows }, now);
        observed.record.lastAttemptAt = now;
        state.quota = observed.record;
        for (const event of observed.events) {
          this.host.log(event.kind === 'exhausted' ? 'warn' : 'info', `pool ${account.id}: ${event.kind === 'early-reset' ? 'early reset' : event.kind} (${event.note})`);
          this.host.emit('quota', { accountId: account.id, kind: event.kind, at: event.at, note: event.note });
        }
      }
    } else {
      if (result.kind === 'signed-out') state.signIn = 'signed-out';
      if (result.kind === 'expired') state.signIn = 'expired';
      state.limitsNote = result.kind === 'unsupported' ? result.reason : null;
      state.quota = readFailed(state.quota, result.reason, now);
      if (result.kind === 'unsupported') state.quota.failures = 0;
    }
    this.due.set(account.id, Math.max(nextReadAt({ record: state.quota, now, random: this.random() }), now + MIN_READ_MS));
    this.save();
    this.host.emit('pools', { changed: true });
  }

  // ---- launches ----

  /** The launcher's choices for this agent: its pool, and each pool account by name. */
  launchOptions(provider: unknown): Array<{ value: string; label: string }> {
    if (!isPoolProvider(provider)) return [];
    const members = this.settings.accounts.filter(account => account.provider === provider);
    if (!members.length) return [];
    return [
      { value: `${POOL_VALUE}${provider}`, label: `${POOL_INFO[provider].label} pool · the account with the most room (${members.length})` },
      ...members.map(account => ({ value: `${MEMBER_VALUE}${account.id}`, label: `${account.label} · own sign-in` }))
    ];
  }

  handles(value: string): boolean { return value.startsWith(POOL_VALUE) || value.startsWith(MEMBER_VALUE) || value.startsWith(SIGN_IN_VALUE); }

  /** `canvastty.launch.prepare` for a pool choice. */
  async prepare(context: PoolLaunchContext, value: string, effort: string, trust: boolean): Promise<PoolAnswer> {
    if (!isPoolProvider(context.provider)) return refuse(`${context.provider} has no subscription pool here.`);
    const provider = context.provider;
    if (context.environment && context.environment.kind !== 'worktree') return refuse(`Pool accounts run on this computer only (a worktree is fine), not in "${context.environment.kind}": a sign-in is never copied elsewhere.`);
    let effortArgs: string[];
    try { effortArgs = effortArguments(provider, effort); } catch (error) { return refuse(errorText(error)); }

    if (value.startsWith(SIGN_IN_VALUE)) return this.prepareSignIn(context, value.slice(SIGN_IN_VALUE.length));

    let account: PoolAccount | undefined;
    const earlier = this.sessions.get(context.sessionId);
    if ((context.restoring || context.resume) && earlier) {
      // A restored or resumed card continues on the account its conversation lives in.
      account = this.find(earlier);
      if (!account) return refuse('The pool account this card ran on was removed; start a new card.');
      if (this.facts(account, context.sessionId).active > 0) return refuse(`${account.label} already runs another card (one card per sign-in); close it first.`);
    } else if (value.startsWith(POOL_VALUE)) {
      const wanted = value.slice(POOL_VALUE.length);
      if (wanted !== provider) return refuse(`The ${wanted.slice(0, 20)} pool cannot run ${POOL_INFO[provider].label}.`);
      const members = this.settings.accounts.filter(entry => entry.provider === provider);
      if (!members.length) return refuse(`There are no ${POOL_INFO[provider].label} accounts in the pool; add one in the Accounts settings.`);
      const { ranked, skipped } = rankPool(members, entry => this.facts(entry, context.sessionId));
      account = ranked[0]?.account;
      if (!account) return refuse(`No ${POOL_INFO[provider].label} pool account can take this card now: ${summarize(skipped)}.`);
    } else {
      account = this.find(value.slice(MEMBER_VALUE.length));
      if (!account) return refuse('That pool account no longer exists; choose another one in the launcher.');
      if (account.provider !== provider) return refuse(`${account.label} is a ${POOL_INFO[account.provider].label} account.`);
      // A pick handed out by pick_account is this launch: it does not count against itself.
      const reservations = this.reservations.get(account.id);
      if (reservations?.length) reservations.shift();
      const facts = this.facts(account, context.sessionId);
      if (facts.active > 0) return refuse(`${account.label} already runs a card (one card per sign-in, so its refresh token is never used twice); use pool:${provider} or close that card.`);
      if (facts.signIn === 'signed-out' || facts.signIn === 'expired') return refuse(`${account.label} is not signed in; sign in again in the Accounts settings.`);
      if (facts.quota.state === 'exhausted') {
        if (context.role === 'subagent') return refuse(`${account.label}'s quota is used up (${facts.quota.note}); omit the account and use pool:${provider} to let the pool choose.`);
        this.host.log('warn', `${account.label}: started although its quota is used up (${facts.quota.note}).`);
      }
    }

    const home = this.homeOf(account.id);
    try {
      await ensureHome(home);
      const folders = [...(trust ? [context.cwd] : []), ...(typeof context.trustedFolder === 'string' ? [context.trustedFolder] : [])];
      if (provider === 'claude' && folders.length) await seedClaudeHome(home, folders);
    } catch (error) {
      return refuse(`The pool account's home could not be prepared: ${errorText(error)}`);
    }
    this.sessions.set(context.sessionId, account.id);
    // Counted until its card ends; without card events nothing would ever release it.
    if (this.cardEvents) this.running.add(context.sessionId);
    const state = this.member(account.id);
    state.lastUsedAt = this.now();
    state.quota = used(state.quota, this.now());
    this.save();
    const args = [...effortArgs, ...(provider === 'codex' && trust ? codexTrustArguments([context.cwd]) : [])];
    return { env: { [POOL_INFO[provider].homeVariable]: home, ...POOL_INFO[provider].env }, secretEnv: {}, args, files: [] };
  }

  private async prepareSignIn(context: PoolLaunchContext, rest: string): Promise<PoolAnswer> {
    const [accountId, nonce] = rest.split(':');
    const pending = nonce ? this.signIns.get(nonce) : undefined;
    // Only the card this plugin opened, once, as the person's own card: never a subagent, never a restore.
    if (context.role === 'subagent' || context.restoring || context.resume || !pending || pending.accountId !== accountId || pending.expiresAt <= this.now()) {
      return refuse('This sign-in card is not current; start the sign-in again from the Accounts settings.');
    }
    this.signIns.delete(nonce!);
    const account = this.find(accountId);
    if (!account || account.provider !== context.provider) return refuse('That pool account no longer exists.');
    if (this.facts(account, context.sessionId).active > 0) return refuse(`A card already runs on ${account.label}; close it before signing in again.`);
    let home: string;
    try { home = await ensureHome(this.homeOf(account.id)); } catch (error) { return refuse(`The pool account's home could not be prepared: ${errorText(error)}`); }
    this.sessions.set(context.sessionId, account.id);
    if (this.cardEvents) this.running.add(context.sessionId);
    this.signInCards.set(context.sessionId, account.id);
    this.save();
    return { env: { [POOL_INFO[account.provider].homeVariable]: home, ...POOL_INFO[account.provider].env }, secretEnv: {}, args: [], files: [] };
  }

  // ---- orchestrator tools ----

  private routeRow(account: PoolAccount, effort: string, facts: MemberFacts, state: RouteRow['state'], reason?: string): RouteRow {
    return {
      provider: account.provider as RouteRow['provider'], agent: POOL_INFO[account.provider].label, accountId: account.id, account: account.label,
      kind: 'subscription', model: 'the account\'s own models', endpoint: `${POOL_INFO[account.provider].label} sign-in on this computer`, state,
      ...(reason ? { reason } : {}),
      ...(state === 'ready' ? { launchOptions: { [PLUGIN_ID]: { account: `${MEMBER_VALUE}${account.id}`, effort, trustFolder: false } } } : {}),
      quota: routeQuota(facts.quota), trust: account.trust
    };
  }

  /** Every pool account as a route row, in the person's order. */
  routes(filter: { provider?: string; effort: string; dataClass?: DataClass; mode?: DataClassMode }): RouteRow[] {
    const rows: RouteRow[] = [];
    for (const provider of POOL_PROVIDERS) {
      if (filter.provider && filter.provider !== provider) continue;
      const members = this.settings.accounts.filter(account => account.provider === provider);
      const { ranked, skipped } = rankPool(members, account => this.facts(account), { ...(filter.dataClass ? { dataClass: filter.dataClass } : {}), ...(filter.mode ? { mode: filter.mode } : {}) });
      for (const account of members) {
        const facts = this.facts(account);
        const out = skipped.find(entry => entry.account.id === account.id);
        if (!out) { rows.push(this.routeRow(account, filter.effort, facts, 'ready', ranked.find(entry => entry.account.id === account.id)?.note)); continue; }
        const state: RouteRow['state'] = facts.signIn === 'signed-out' || facts.signIn === 'expired' ? 'signed-out' : facts.quota.state === 'exhausted' ? 'quota-exhausted' : facts.active > 0 ? 'busy' : 'data-class';
        rows.push(this.routeRow(account, filter.effort, facts, state, out.reason));
      }
    }
    return rows;
  }

  /** The best pool account for this agent now, reserved for a minute so parallel picks spread over the pool. */
  pick(provider: PoolProvider, request: { effort: string; dataClass?: DataClass; mode?: DataClassMode }): { accountId: string; account: string; launchOptions: Record<string, Record<string, string | boolean>>; why: string; quota: RouteQuota; trust: PoolTrust } | null {
    const members = this.settings.accounts.filter(account => account.provider === provider);
    if (!members.length) return null;
    const { ranked, skipped } = rankPool(members, account => this.facts(account), { ...(request.dataClass ? { dataClass: request.dataClass } : {}), ...(request.mode ? { mode: request.mode } : {}) });
    const chosen = ranked[0];
    if (!chosen) throw new Error(`No ${POOL_INFO[provider].label} pool account is free: ${summarize(skipped)}.`);
    this.reservations.set(chosen.account.id, [...(this.reservations.get(chosen.account.id) ?? []), this.now() + RESERVATION_MS]);
    const quota = routeQuota(chosen.facts.quota);
    const room = quota.remainingPercent === null ? `quota ${quota.state}` : `${Math.round((100 - quota.remainingPercent) * 10) / 10}% used, ${quota.remainingPercent}% left (${quota.confidence})`;
    return {
      accountId: chosen.account.id, account: chosen.account.label, trust: chosen.account.trust, quota,
      launchOptions: { [PLUGIN_ID]: { account: `${MEMBER_VALUE}${chosen.account.id}`, effort: request.effort, trustFolder: false } },
      why: `${POOL_INFO[provider].label} on the pool account ${chosen.account.label}: ${room}, the most room among ${ranked.length} free of ${members.length}`
        + (chosen.note ? `; ${chosen.note}` : '') + (skipped.length ? `; skipped ${summarize(skipped)}` : '') + '.'
    };
  }

  // ---- the state file ----

  private save(): void {
    this.writeTimer ??= setTimeout(() => { this.writeTimer = null; void this.flush(); }, WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const ids = new Set(this.settings.accounts.map(account => account.id));
    const members = Object.fromEntries([...this.members].filter(([id]) => ids.has(id) || this.unread));
    const sessions = Object.fromEntries([...this.sessions].filter(([, id]) => ids.has(id) || this.unread).slice(-2_000));
    const json = JSON.stringify({ version: 1, members, sessions });
    this.writing = this.writing.then(async () => {
      const temporary = join(this.dataDir, `.${POOL_STATE_FILE}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch {
        this.host.log('warn', 'pools: the pool state could not be saved');
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    return this.writing;
  }
}

/** "27 used up, 3 not signed in": the skipped members grouped by reason, largest group first. */
function summarize(skipped: ReadonlyArray<{ account: PoolAccount; reason: string }>): string {
  if (!skipped.length) return 'none is set up';
  const groups = new Map<string, string[]>();
  for (const entry of skipped) {
    const key = entry.reason.replace(/\(.*\)$/u, '').trim();
    groups.set(key, [...(groups.get(key) ?? []), entry.account.label]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length)
    .map(([reason, labels]) => `${labels.length} ${reason} (${labels.slice(0, 5).join(', ')}${labels.length > 5 ? ', …' : ''})`).join('; ');
}

export { DATA_CLASSES, covers };

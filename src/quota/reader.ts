/**
 * The per-account quota reader inside the Accounts service: it reads each account's quota from the provider's own
 * quota endpoint on its own schedule (no page needs to be open), keeps the state across restarts (`quota.json` in the
 * plugin's data folder, with when it was read), and answers list_routes / pick_account / the settings page.
 *
 * Bounds: one request at a time per account and at most two at once; never twice within SCHEDULE.minMs; at most
 * MAX_READS_PER_HOUR per account; 10 s per request; answers up to 256 KB. The key is read from the plugin's secrets
 * just before a request and only if it was saved for this account's address; it goes only to the account's own host
 * (redirects refused) and never into a log, an error, the state file or an answer.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountKeyed, decisionsOnlyAccount, type Account } from '../shared/accounts.ts';
import {
  emptyRecord, loadRecord, nextReadAt, observe, readFailed, used, viewOf, SCHEDULE,
  type QuotaEvent, type QuotaObservation, type QuotaRecord, type QuotaView
} from './model.ts';
import { limitObservation, parseZaiLimitError, parseZaiQuota, ZaiQuotaError, ZAI_QUOTA_HOSTS, ZAI_QUOTA_PATH } from './zai.ts';

export interface QuotaResponse { status: number; text(): Promise<string> }
export type QuotaFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<QuotaResponse>;

export interface QuotaReaderOptions {
  dataDir: string;
  accounts(): readonly Account[];
  /** The account's key, only if it was saved for the account's current address; null otherwise. */
  key(account: Account): Promise<string | null>;
  log(level: 'info' | 'warn', message: string): void;
  /** An exhaustion, recovery or early reset (for the page). */
  onEvent?(accountId: string, event: QuotaEvent): void;
  /** The network; the service passes the real fetch only when CanvasTTY starts it (tests and tools get none). */
  fetch?: QuotaFetch;
  now?: () => number;
  random?: () => number;
}

export const QUOTA_FILE = 'quota.json';
const TICK_MS = 15_000;
const REQUEST_MS = 10_000;
const MAX_BODY = 256 * 1_024;
const MAX_CONCURRENT = 2;
export const MAX_READS_PER_HOUR = 40;
/** A list_routes or pick_account call reads an account again when its data is older than this. */
const DEMAND_REFRESH_MS = 10 * 60_000;
const WRITE_DELAY_MS = 500;

const hostOf = (url: string): string | null => { try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.host.toLowerCase() : null; } catch { return null; } };

/** The quota endpoint of an account on a provider whose endpoint is known, on the account's own host; or null. */
export function quotaUrlOf(account: Pick<Account, 'baseUrl' | 'preset'>): string | null {
  if (!accountKeyed(account as Account) || decisionsOnlyAccount(account)) return null;
  const host = hostOf(account.baseUrl);
  return host && ZAI_QUOTA_HOSTS.includes(host) ? `https://${host}${ZAI_QUOTA_PATH}` : null;
}

/** The record key of an account this plugin cannot read (only limits it is told about). */
const untracked = (id: string): string => `untracked:${id}`;

/** No network unless one is given: a reader built by a test or a script never reaches a provider. */
const offline: QuotaFetch = async () => { throw new Error('quota reading has no network here'); };
export const networkFetch: QuotaFetch = (url, init) => fetch(url, init);

export class QuotaReader {
  private readonly options: QuotaReaderOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly fetcher: QuotaFetch;
  private readonly file: string;
  private records = new Map<string, QuotaRecord>();
  /** Which address each record was read for: a changed address starts over. */
  private readonly urls = new Map<string, string>();
  private readonly due = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly reads = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: QuotaReaderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.fetcher = options.fetch ?? offline;
    this.file = join(options.dataDir, QUOTA_FILE);
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; accounts?: unknown; urls?: unknown };
      if (saved.version === 1 && saved.accounts && typeof saved.accounts === 'object') {
        for (const [id, value] of Object.entries(saved.accounts as Record<string, unknown>).slice(0, 64)) {
          const record = loadRecord(value);
          const url = saved.urls && typeof saved.urls === 'object' ? (saved.urls as Record<string, unknown>)[id] : null;
          if (record && /^[a-z0-9][a-z0-9-]{0,39}$/u.test(id)) { this.records.set(id, record); if (typeof url === 'string' && url.length < 200) this.urls.set(id, url); }
        }
      }
    } catch { /* nothing saved yet, or unreadable: start empty */ }
  }

  /** Reads on its own schedule from now on (the service calls this once; tests drive tick()). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.allSettled([...this.inFlight.values()]);
    await this.flush();
  }

  /** The accounts this reader can read, with their quota URL; records of others are dropped. */
  private readable(): Array<{ account: Account; url: string }> {
    const list: Array<{ account: Account; url: string }> = [];
    for (const account of this.options.accounts()) {
      const url = quotaUrlOf(account);
      if (url) list.push({ account, url });
    }
    return list;
  }

  private record(account: Account, url: string): QuotaRecord {
    if (this.urls.get(account.id) !== url) { this.records.set(account.id, emptyRecord()); this.urls.set(account.id, url); this.due.delete(account.id); }
    return this.records.get(account.id) ?? emptyRecord();
  }

  private set(id: string, record: QuotaRecord): void {
    this.records.set(id, record);
    this.due.set(id, nextReadAt({ record, now: this.now(), random: this.random() }));
    this.save();
  }

  /** The quota of an account as routes show it; null when this plugin has no way to know it. */
  view(account: Account): QuotaView | null {
    const url = quotaUrlOf(account);
    const record = this.urls.get(account.id) === (url ?? untracked(account.id)) ? this.records.get(account.id) : undefined;
    if (!record) return url ? viewOf(emptyRecord(), this.now()) : null;
    return viewOf(record, this.now());
  }

  events(accountId: string): QuotaEvent[] { return [...(this.records.get(accountId)?.events ?? [])]; }

  /** A launch was prepared on the account: counted until the next read, and it is read more often while used. */
  used(account: Account): void {
    const url = quotaUrlOf(account);
    if (!url) return;
    this.set(account.id, used(this.record(account, url), this.now()));
  }

  /** A limit seen elsewhere (CanvasTTY's activity, an error body): exhausted now. */
  noteLimit(account: Account, observation: QuotaObservation): void {
    const url = quotaUrlOf(account) ?? untracked(account.id);
    this.apply(account.id, observe(this.record(account, url), observation, this.now()));
  }

  /** A limit error text or body for an account (Z.AI codes); true when it was one. */
  noteError(account: Account, body: unknown): boolean {
    const now = this.now();
    const limit = parseZaiLimitError(body, now);
    if (!limit) return false;
    this.noteLimit(account, limitObservation(limit, now));
    return true;
  }

  /** Forget an account (removed, or its address or key changed). */
  forget(accountId: string): void {
    this.records.delete(accountId); this.urls.delete(accountId); this.due.delete(accountId); this.reads.delete(accountId);
    this.save();
  }

  private apply(id: string, result: { record: QuotaRecord; events: QuotaEvent[] }): void {
    this.set(id, result.record);
    for (const event of result.events) {
      this.options.log(event.kind === 'exhausted' ? 'warn' : 'info', `quota ${id}: ${event.kind === 'early-reset' ? 'early reset' : event.kind} (${event.note})`);
      this.options.onEvent?.(id, event);
    }
  }

  /** Accounts asked about now: read the ones whose data is old (in the background, bounded). */
  demand(accounts: readonly Account[]): void {
    const now = this.now();
    for (const account of accounts) {
      const url = quotaUrlOf(account);
      if (!url) continue;
      const record = this.record(account, url);
      const last = Math.max(record.observedAt ?? 0, record.lastAttemptAt ?? 0);
      if (now - last > DEMAND_REFRESH_MS && record.failures === 0) this.due.set(account.id, now);
    }
    void this.tick();
  }

  /** Reads every account that is due (the timer calls it; tests call it directly). */
  async tick(): Promise<void> {
    const now = this.now();
    const list = this.readable();
    // Records of accounts that are gone (or whose address changed) are dropped; passive ones of others are kept.
    const addresses = new Map(this.options.accounts().map(account => [account.id, quotaUrlOf(account) ?? untracked(account.id)]));
    let dropped = false;
    for (const id of [...this.records.keys()]) if (addresses.get(id) !== this.urls.get(id)) { this.records.delete(id); this.urls.delete(id); this.due.delete(id); dropped = true; }
    if (dropped) this.save();
    const waiting: Promise<void>[] = [];
    for (const { account, url } of list) {
      if (this.inFlight.size >= MAX_CONCURRENT) break;
      if (this.inFlight.has(account.id)) continue;
      const record = this.record(account, url);
      const at = this.due.get(account.id) ?? nextReadAt({ record, now, random: this.random() });
      if (!this.due.has(account.id)) this.due.set(account.id, at);
      if (at > now) continue;
      waiting.push(this.read(account, url));
    }
    await Promise.allSettled(waiting);
  }

  /** One bounded read of one account, now (unless it was read too recently). */
  read(account: Account, url: string): Promise<void> {
    const running = this.inFlight.get(account.id);
    if (running) return running;
    const now = this.now();
    const record = this.record(account, url);
    const last = Math.max(record.observedAt ?? 0, record.lastAttemptAt ?? 0);
    const hour = (this.reads.get(account.id) ?? []).filter(at => now - at < 3_600_000);
    if (now - last < SCHEDULE.minMs || hour.length >= MAX_READS_PER_HOUR) {
      this.due.set(account.id, Math.max(last + SCHEDULE.minMs, hour.length >= MAX_READS_PER_HOUR ? hour[0]! + 3_600_000 : 0));
      return Promise.resolve();
    }
    this.reads.set(account.id, [...hour, now]);
    const run = this.request(account, url).finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, run);
    return run;
  }

  private async request(account: Account, url: string): Promise<void> {
    const started = this.now();
    let key: string | null = null;
    try { key = await this.options.key(account); } catch { key = null; }
    if (!key) { this.set(account.id, readFailed(this.record(account, url), 'no key saved for this address', started)); return; }
    const scrub = (text: string): string => key ? text.split(key).join('[key]') : text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    timer.unref?.();
    try {
      // Only the account's own host (quotaUrlOf), never followed elsewhere.
      if (new URL(url).host !== hostOf(account.baseUrl)) throw new ZaiQuotaError('the quota address is not the account\'s host');
      const response = await this.fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
      const body = (await response.text()).slice(0, MAX_BODY);
      const now = this.now();
      if (response.status === 401 || response.status === 403) throw new ZaiQuotaError(`the provider refused the key (${response.status})`, 'auth');
      if (response.status === 429 || response.status >= 400) {
        const limit = parseZaiLimitError(body, now);
        if (limit) { this.apply(account.id, observe(this.record(account, url), limitObservation(limit, now), now)); return; }
        throw new ZaiQuotaError(`the quota endpoint answered HTTP ${response.status}`, 'refused');
      }
      let json: unknown;
      try { json = JSON.parse(body); } catch { throw new ZaiQuotaError('the quota answer is not JSON'); }
      const limit = parseZaiLimitError(json, now);
      if (limit && limit.kind === 'exhausted') { this.apply(account.id, observe(this.record(account, url), limitObservation(limit, now), now)); return; }
      const observation = parseZaiQuota(json, now);
      const result = observe(this.record(account, url), observation, now);
      result.record.lastAttemptAt = now;
      this.apply(account.id, result);
    } catch (error) {
      const text = error instanceof ZaiQuotaError ? error.message : controller.signal.aborted ? 'the quota endpoint did not answer in time' : 'the quota endpoint could not be reached';
      this.set(account.id, readFailed(this.record(account, url), scrub(text), this.now()));
      this.options.log('warn', `quota ${account.id}: ${scrub(text)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- the state file ----

  private save(): void {
    this.writeTimer ??= setTimeout(() => { this.writeTimer = null; void this.flush(); }, WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const json = JSON.stringify({ version: 1, accounts: Object.fromEntries(this.records), urls: Object.fromEntries(this.urls) });
    this.writing = this.writing.then(async () => {
      const temporary = join(this.options.dataDir, `.${QUOTA_FILE}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch {
        this.options.log('warn', 'quota: the quota state could not be saved');
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    return this.writing;
  }
}

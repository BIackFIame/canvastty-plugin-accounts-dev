/**
 * Each coding-plan account's model list, read from the plan's own host with the account's key (plans/models.ts says
 * which endpoint and why), kept in `models.json` in the plugin's data folder with when it was read.
 *
 * Bounds: once a day per account on its own schedule, and on "Read now" (never twice within MIN_GAP_MS); after a failed
 * read again in an hour; one request at a time per account and at most two at once; 10 s per request; answers up to
 * 256 KB; redirects refused. The key is read just before a request and only when it was saved for the account's
 * address; it goes only to the account's own host and never into a log, an error, the file or an answer.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account } from '../shared/accounts.ts';
import type { QuotaFetch } from '../quota/reader.ts';
import { PLAN_INFO, planOf, type PlanProvider } from './plans.ts';
import { MAX_MODELS, bundledList, defaultModels, parseModelList, type PlanModelList } from './models.ts';

export const MODELS_FILE = 'models.json';
export const REFRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
export const MIN_GAP_MS = 30_000;
const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;
const REQUEST_MS = 10_000;
const MAX_BODY = 256 * 1_024;
const MAX_CONCURRENT = 2;
const WRITE_DELAY_MS = 500;

interface Entry { url: string; models: string[] | null; readAt: number | null; attemptAt: number | null; note: string | null }

/** The plan's model-list address on the account's own host, or null for an account that is not a plan's. */
export function modelsUrlOf(account: Pick<Account, 'preset' | 'baseUrl'>): string | null {
  const plan = planOf(account);
  return plan ? `https://${plan.host}${PLAN_INFO[plan.provider].openaiPath}/models` : null;
}

export class PlanModelReader {
  private readonly options: { dataDir: string; accounts(): readonly Account[]; key(account: Account): Promise<string | null>; log(level: 'info' | 'warn', message: string): void; onChange?(accountId: string): void; fetch?: QuotaFetch; now?: () => number };
  private readonly now: () => number;
  private readonly fetcher: QuotaFetch;
  private readonly file: string;
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(options: PlanModelReader['options']) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? (async () => { throw new Error('model lists have no network here'); });
    this.file = join(options.dataDir, MODELS_FILE);
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; accounts?: unknown };
      if (saved.version === 1 && saved.accounts && typeof saved.accounts === 'object') {
        for (const [id, value] of Object.entries(saved.accounts as Record<string, unknown>).slice(0, 64)) {
          const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(id) || typeof entry.url !== 'string' || entry.url.length > 200) continue;
          const models = Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === 'string' && /^[A-Za-z0-9._-]{1,100}$/u.test(model)).slice(0, MAX_MODELS) : null;
          const time = (at: unknown): number | null => typeof at === 'number' && Number.isFinite(at) ? at : null;
          this.entries.set(id, { url: entry.url, models: models?.length ? models : null, readAt: time(entry.readAt), attemptAt: time(entry.attemptAt), note: typeof entry.note === 'string' ? entry.note.slice(0, 200) : null });
        }
      }
    } catch { /* nothing saved yet, or unreadable: start with the bundled lists */ }
  }

  /** Reads on its own schedule from now on: the first round a minute after start, then every 15 minutes. */
  start(): void {
    if (this.timer || this.firstTimer) return;
    this.firstTimer = setTimeout(() => { this.firstTimer = null; void this.tick(); }, FIRST_TICK_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.firstTimer) { clearTimeout(this.firstTimer); this.firstTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.allSettled([...this.inFlight.values()]);
    await this.flush();
  }

  private entry(account: Account): Entry | undefined {
    const url = modelsUrlOf(account);
    const entry = this.entries.get(account.id);
    return url && entry?.url === url ? entry : undefined;
  }

  /** The account's list: its own when one was read for its address, the bundled one otherwise. */
  list(account: Account): PlanModelList | null {
    const plan = planOf(account);
    if (!plan) return null;
    const entry = this.entry(account);
    if (entry?.models) return { models: [...entry.models], source: 'live', readAt: entry.readAt, note: entry.note, defaults: defaultModels(plan.provider, entry.models) };
    return { ...bundledList(plan.provider, entry?.note ?? null), readAt: entry?.readAt ?? null };
  }

  /** An account removed, or its key or address changed: its list is read again from scratch. */
  forget(accountId: string): void {
    if (this.entries.delete(accountId)) this.save();
  }

  private due(account: Account, now: number): boolean {
    const entry = this.entry(account);
    if (!entry || entry.attemptAt === null) return true;
    const last = Math.max(entry.attemptAt, entry.readAt ?? 0);
    return now - last >= (entry.readAt !== null && entry.readAt >= entry.attemptAt ? REFRESH_MS : RETRY_MS);
  }

  /** Reads every plan account whose list is due (the timer calls it; tests call it directly). */
  async tick(): Promise<void> {
    const now = this.now();
    const ids = new Set(this.options.accounts().map(account => account.id));
    let dropped = false;
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) { this.entries.delete(id); dropped = true; }
    if (dropped) this.save();
    const waiting: Promise<void>[] = [];
    for (const account of this.options.accounts()) {
      if (this.inFlight.size >= MAX_CONCURRENT) break;
      if (!modelsUrlOf(account) || this.inFlight.has(account.id) || !this.due(account, now)) continue;
      waiting.push(this.read(account));
    }
    await Promise.allSettled(waiting);
  }

  /** One read now ("Read now", a new key); skipped within MIN_GAP_MS of the last one. */
  read(account: Account): Promise<void> {
    const running = this.inFlight.get(account.id);
    if (running) return running;
    const url = modelsUrlOf(account);
    // No network unless one is given: a service built by a test or a script never reaches a provider.
    if (!url || !this.options.fetch) return Promise.resolve();
    const entry = this.entry(account);
    const now = this.now();
    if (entry?.attemptAt !== null && entry?.attemptAt !== undefined && now - entry.attemptAt < MIN_GAP_MS) return Promise.resolve();
    const run = this.request(account, url).finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, run);
    return run;
  }

  private settle(account: Account, url: string, patch: Partial<Entry>): void {
    const before = this.entry(account);
    const next: Entry = { url, models: before?.models ?? null, readAt: before?.readAt ?? null, attemptAt: this.now(), note: null, ...patch };
    this.entries.set(account.id, next);
    this.save();
    if (JSON.stringify(before?.models ?? null) !== JSON.stringify(next.models)) this.options.onChange?.(account.id);
  }

  private async request(account: Account, url: string): Promise<void> {
    const provider = planOf(account)!.provider as PlanProvider;
    let key: string | null = null;
    try { key = await this.options.key(account); } catch { key = null; }
    if (!key) { this.settle(account, url, { note: 'no key is saved for this address' }); return; }
    const scrub = (text: string): string => text.split(key!).join('[key]');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_MS);
    timer.unref?.();
    try {
      // Only the account's own host, never followed elsewhere.
      if (new URL(url).host !== new URL(account.baseUrl).host) throw new Error('the model list address is not the account\'s host');
      const response = await this.fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
      const body = (await response.text()).slice(0, MAX_BODY);
      if (response.status === 401 || response.status === 403) throw new Error(`the provider refused the key (${response.status})`);
      if (response.status === 404) { this.settle(account, url, { models: null, readAt: this.now(), note: 'the plan\'s host has no model list; the built-in list is used' }); return; }
      if (response.status >= 400) throw new Error(`the model list answered HTTP ${response.status}`);
      let json: unknown;
      try { json = JSON.parse(body); } catch { throw new Error('the model list is not JSON'); }
      const models = parseModelList(provider, json);
      if (!models) { this.settle(account, url, { models: null, readAt: this.now(), note: 'the plan\'s host lists no coding model; the built-in list is used' }); return; }
      this.settle(account, url, { models, readAt: this.now() });
    } catch (error) {
      const text = controller.signal.aborted ? 'the model list did not answer in time'
        : error instanceof Error && !/fetch failed|ECONN|ENOTFOUND|network/iu.test(error.message) ? error.message : 'the model list could not be reached';
      // A failed read keeps the last good list (still the account's own) and says why.
      this.settle(account, url, { note: scrub(text).slice(0, 200) });
      this.options.log('warn', `models ${account.id}: ${scrub(text)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private save(): void {
    this.writeTimer ??= setTimeout(() => { this.writeTimer = null; void this.flush(); }, WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  flush(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const json = JSON.stringify({ version: 1, accounts: Object.fromEntries(this.entries) });
    this.writing = this.writing.then(async () => {
      const temporary = join(this.options.dataDir, `.${MODELS_FILE}.${randomUUID()}.tmp`);
      try {
        await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
        await writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch {
        this.options.log('warn', 'models: the model lists could not be saved');
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    });
    return this.writing;
  }
}

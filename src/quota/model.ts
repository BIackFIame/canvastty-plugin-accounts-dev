/**
 * Quota state of one account, kept from reads of the provider's own quota endpoint and from the limit errors this
 * plugin is told about. Pure: the reader, the routes and the tests decide from the same functions.
 *
 * Rules (the owner's): a predicted reset is never trusted blindly, and unknown is never zero.
 * - A window whose reset time passed is "probably reset": the account is offered again and read again soon.
 * - A fresh read that shows room again clears the exhaustion at once; when the used share dropped substantially before
 *   the announced reset it is an "early reset" (earlyResetOf; providers hand out resets and promotional quota).
 * - Nothing read (or read long ago) is `unknown`/`stale`: never treated as used up.
 */

/** `core-limits`: CanvasTTY's own limits read of a subscription account home (pools). */
export type QuotaSource = 'zai-quota-api' | 'zai-limit-error' | 'host-activity' | 'core-limits';

export interface QuotaWindow {
  /** Stable per window kind, for example `zai:tokens:300`. */
  id: string;
  /** "5h", "7d", "MCP month". */
  label: string;
  usedPercent: number | null;
  /** Counts when the provider gives them. */
  used: number | null;
  limit: number | null;
  windowMinutes: number | null;
  /** Epoch ms, or null when not given (or not plausible). */
  resetsAt: number | null;
  /** false: the window limits tools (web search, MCP), not model calls; it never blocks a route. */
  models: boolean;
}

export interface QuotaObservation {
  source: QuotaSource;
  at: number;
  windows: QuotaWindow[];
  /** A limit error: the account is refused until `until` (null: no time given). */
  exhausted?: { until: number | null; code: string; zoneGuessed?: boolean };
  plan?: string | null;
}

export type QuotaEventKind = 'exhausted' | 'early-reset' | 'reset' | 'recovered';

/** One window that reset before its announced time (the owner's definition: a clear drop of the used share). */
export interface EarlyResetDetail {
  /** The window kind, for example `zai:tokens:300` (5 h) or `zai:tokens:10080` (weekly). */
  window: string;
  usedBefore: number;
  usedAfter: number;
  /** The reset time the read before announced. */
  announcedResetAt: number;
  /** The reset time the provider reports now (a new window, or still the old time, or none). */
  reportedResetAtAfter: number | null;
  /** The provider still shows the old reset time; its arrival is then not another reset unless use drops again. */
  resetTimeKept: boolean;
}

export interface QuotaEvent { at: number; kind: QuotaEventKind; note: string; early?: EarlyResetDetail[] }

export interface QuotaRecord {
  observedAt: number | null;
  source: QuotaSource | null;
  windows: QuotaWindow[];
  plan: string | null;
  /** Refused for quota until this time (from a read at 100 % or a limit error); null: not exhausted. */
  exhaustedUntil: number | null;
  /** Exhausted, but no reset time is known: only a fresh read clears it. */
  exhaustedOpen: boolean;
  exhaustedAt: number | null;
  /** The exhaustion came from a limit error (a read right after it may still lag behind). */
  exhaustedByError: boolean;
  lastAttemptAt: number | null;
  failures: number;
  lastError: string | null;
  /** Launches prepared on the account since the last read (own usage accounting between reads). */
  launchesSinceRead: number;
  lastUseAt: number | null;
  events: QuotaEvent[];
}

export type QuotaState = 'ok' | 'low' | 'exhausted' | 'presumed-reset' | 'unknown' | 'stale';
export type Confidence = 'exact' | 'estimated' | 'none';

/** What list_routes, pick_account and the settings page show. */
export interface QuotaView {
  state: QuotaState;
  /** Percent left in the tightest window that limits model calls (null: unknown). */
  remainingPercent: number | null;
  window: string | null;
  /** When the tightest (or the exhausted) window resets, epoch ms. */
  resetsAt: number | null;
  source: QuotaSource | null;
  observedAt: number | null;
  /** Age of the last read in minutes (null: never read). */
  ageMinutes: number | null;
  confidence: Confidence;
  launchesSinceRead: number;
  note: string;
}

/** A read older than this is shown as stale and counts as unknown (never as used up). */
export const STALE_MS = 30 * 60_000;
/** A read this fresh counts as exact. */
export const EXACT_MS = 10 * 60_000;
/** Clock skew and reporting jitter tolerated around a reset time. */
export const RESET_TOLERANCE_MS = 2 * 60_000;
/** Early reset (the owner's rule, as CanvasTTY's core detects it): a drop of the used share by at least
 *  max(EARLY_RESET_MIN_DROP, half of what was used), or to EARLY_RESET_NEAR_ZERO % or less by more than
 *  EARLY_RESET_NOISE points, while the announced reset is more than EARLY_RESET_GRACE_MS away. */
export const EARLY_RESET_MIN_DROP = 5;
export const EARLY_RESET_NEAR_ZERO = 5;
export const EARLY_RESET_NOISE = 2;
export const EARLY_RESET_GRACE_MS = 5 * 60_000;
/** A reported reset time within this of the announced one is the same (the old time kept). */
export const SAME_RESET_TIME_MS = 60_000;
/** Below this percentage left the account is `low` (still offered). */
export const LOW_PERCENT = 10;
/** A read this soon after a limit error does not clear it (the provider's counters may lag). */
export const ERROR_GRACE_MS = 2 * 60_000;
const MAX_EVENTS = 12;
const MAX_WINDOWS = 8;

export const emptyRecord = (): QuotaRecord => ({
  observedAt: null, source: null, windows: [], plan: null, exhaustedUntil: null, exhaustedOpen: false, exhaustedAt: null, exhaustedByError: false,
  lastAttemptAt: null, failures: 0, lastError: null, launchesSinceRead: 0, lastUseAt: null, events: []
});

const pushEvent = (record: QuotaRecord, event: QuotaEvent): void => {
  record.events.push(event);
  if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
};

const time = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * Did this window reset before the time the previous read announced? Yes when its used share dropped substantially
 * — by at least max(5 points, half of what was used), or down to 5 % or less by more than 2 points — while that time
 * was still more than 5 minutes ahead,
 * whatever the provider reports as the next reset afterwards (a fresh window, or still the old time). A reset time
 * that moves without a drop is not a reset; a small dip (a rolling window shedding old use) is not one either.
 */
export function earlyResetOf(previous: QuotaWindow, next: QuotaWindow, now: number): EarlyResetDetail | null {
  if (previous.resetsAt === null || previous.usedPercent === null || next.usedPercent === null) return null;
  // Same thresholds as CanvasTTY's own detector (LimitsService.detectEarlyResets).
  if (now >= previous.resetsAt - EARLY_RESET_GRACE_MS) return null;
  const drop = previous.usedPercent - next.usedPercent;
  if (!(drop >= Math.max(EARLY_RESET_MIN_DROP, previous.usedPercent / 2) || (next.usedPercent <= EARLY_RESET_NEAR_ZERO && drop > EARLY_RESET_NOISE))) return null;
  return {
    window: next.id, usedBefore: previous.usedPercent, usedAfter: next.usedPercent, announcedResetAt: previous.resetsAt,
    reportedResetAtAfter: next.resetsAt, resetTimeKept: next.resetsAt !== null && Math.abs(next.resetsAt - previous.resetsAt) <= SAME_RESET_TIME_MS
  };
}

const earlyNote = (detail: EarlyResetDetail, label: string): string =>
  `${label}: ${Math.round(detail.usedBefore)}% → ${Math.round(detail.usedAfter)}% before ${time(detail.announcedResetAt)}${detail.resetTimeKept ? ' (the old reset time is still shown)' : detail.reportedResetAtAfter ? `, next reset ${time(detail.reportedResetAtAfter)}` : ''}`;

const modelWindows = (windows: readonly QuotaWindow[]): QuotaWindow[] => windows.filter(window => window.models && window.usedPercent !== null);

/**
 * Takes one observation into the record (a copy is returned) and says what happened: exhausted, recovered, an early
 * reset, or a reset at the predicted time.
 */
export function observe(current: QuotaRecord, observation: QuotaObservation, now: number): { record: QuotaRecord; events: QuotaEvent[] } {
  const record: QuotaRecord = structuredClone(current);
  const events: QuotaEvent[] = [];
  const add = (kind: QuotaEventKind, note: string, early?: EarlyResetDetail[]): void => { const event: QuotaEvent = { at: now, kind, note, ...(early?.length ? { early } : {}) }; events.push(event); pushEvent(record, event); };
  const wasExhausted = record.exhaustedOpen || (record.exhaustedUntil !== null);
  const predicted = record.exhaustedUntil;

  if (observation.exhausted) {
    // A limit error: refused now, whatever the last read said.
    const until = observation.exhausted.until !== null && observation.exhausted.until > now ? observation.exhausted.until : null;
    record.exhaustedUntil = until;
    record.exhaustedOpen = until === null;
    record.exhaustedAt = now;
    record.exhaustedByError = true;
    if (!wasExhausted) add('exhausted', `limit error ${observation.exhausted.code}${until ? `, resets ${time(until)}${observation.exhausted.zoneGuessed ? ' (time zone assumed)' : ''}` : ', no reset time given'}`);
    record.source = record.source ?? observation.source;
    return { record, events };
  }

  const windows = observation.windows.slice(0, MAX_WINDOWS);
  // Per window kind. After a limit error the windows count as full until the reset it named.
  const errorBase = wasExhausted && record.exhaustedByError && predicted !== null;
  const previous = new Map(record.windows.map(window => [window.id, errorBase && window.models ? { ...window, usedPercent: 100, resetsAt: predicted } : window]));
  const early: EarlyResetDetail[] = [];
  const notes: string[] = [];
  for (const window of windows) {
    const before = previous.get(window.id) ?? (errorBase && window.models ? { ...window, usedPercent: 100, resetsAt: predicted } : undefined);
    const detail = before && window.models ? earlyResetOf(before, window, now) : null;
    if (detail) { early.push(detail); notes.push(earlyNote(detail, window.label)); }
  }
  const full = modelWindows(windows).filter(window => window.usedPercent! >= 100);
  record.observedAt = observation.at;
  record.source = observation.source;
  record.windows = windows;
  record.plan = observation.plan ?? record.plan;
  record.lastError = null;
  record.failures = 0;
  record.launchesSinceRead = 0;

  if (full.length) {
    const resets = full.map(window => window.resetsAt).filter((at): at is number => at !== null && at > now);
    // Refused until the last of the full windows resets; none with a time: open until a read shows room.
    const until = resets.length === full.length ? Math.max(...resets) : null;
    record.exhaustedUntil = until;
    record.exhaustedOpen = until === null;
    record.exhaustedByError = false;
    if (!wasExhausted) { record.exhaustedAt = now; add('exhausted', `${full.map(window => window.label).join(', ')} at 100%${until ? `, resets ${time(until)}` : ''}`); }
    return { record, events };
  }
  // A read just after a limit error may not show it yet: the error wins for ERROR_GRACE_MS.
  if (wasExhausted && record.exhaustedByError && record.exhaustedAt !== null && now - record.exhaustedAt < ERROR_GRACE_MS) return { record, events };
  if (wasExhausted) {
    record.exhaustedByError = false;
    record.exhaustedUntil = null;
    record.exhaustedOpen = false;
    record.exhaustedAt = null;
    // Room again: usable at once. It is an early reset only when the used share dropped clearly before the time.
    if (early.length) add('early-reset', notes.join('; '), early);
    else if (predicted !== null && now >= predicted - RESET_TOLERANCE_MS) add('reset', `reset as predicted (${time(predicted)})`);
    else add('recovered', predicted !== null ? `some room again before ${time(predicted)}` : 'room again');
    return { record, events };
  }
  if (early.length) add('early-reset', notes.join('; '), early);
  return { record, events };
}

/** A failed read: counted for the back-off; what was known stays (it only ages). */
export function readFailed(current: QuotaRecord, error: string, now: number): QuotaRecord {
  return { ...structuredClone(current), lastAttemptAt: now, failures: current.failures + 1, lastError: error.slice(0, 160) };
}

/** The account is being used (a launch was prepared on it). */
export function used(current: QuotaRecord, now: number): QuotaRecord {
  return { ...structuredClone(current), lastUseAt: now, launchesSinceRead: Math.min(current.launchesSinceRead + 1, 999) };
}

/** What the record means now. */
export function viewOf(record: QuotaRecord, now: number): QuotaView {
  const age = record.observedAt === null ? null : Math.max(0, Math.round((now - record.observedAt) / 60_000));
  const base = { source: record.source, observedAt: record.observedAt, ageMinutes: age, launchesSinceRead: record.launchesSinceRead };
  // A limit error or a full window, with its reset still ahead: refused (until a fresh read shows room).
  if (record.exhaustedUntil !== null && record.exhaustedUntil > now) {
    return { ...base, state: 'exhausted', remainingPercent: 0, window: null, resetsAt: record.exhaustedUntil, confidence: 'exact', note: `used up; resets ${time(record.exhaustedUntil)}` };
  }
  if (record.exhaustedUntil !== null) {
    return { ...base, state: 'presumed-reset', remainingPercent: null, window: null, resetsAt: record.exhaustedUntil, confidence: 'estimated', note: 'its reset time passed: probably reset, read again soon' };
  }
  if (record.exhaustedOpen) {
    // No reset time: exhausted while the observation is fresh, then unknown (never used up forever).
    if (record.exhaustedAt !== null && now - record.exhaustedAt <= STALE_MS) return { ...base, state: 'exhausted', remainingPercent: 0, window: null, resetsAt: null, confidence: 'estimated', note: 'used up; no reset time given, read again soon' };
    return { ...base, state: 'unknown', remainingPercent: null, window: null, resetsAt: null, confidence: 'none', note: 'was used up with no reset time; not read since' };
  }
  if (record.observedAt === null) return { ...base, state: 'unknown', remainingPercent: null, window: null, resetsAt: null, confidence: 'none', note: record.lastError ? `not readable: ${record.lastError}` : 'not read yet' };
  if (now - record.observedAt > STALE_MS) return { ...base, state: 'stale', remainingPercent: null, window: null, resetsAt: null, confidence: 'none', note: `read ${age} min ago; counts as unknown${record.lastError ? ` (last read failed: ${record.lastError})` : ''}` };
  let tight: QuotaWindow | null = null;
  let presumed = false;
  for (const window of modelWindows(record.windows)) {
    if (window.resetsAt !== null && window.resetsAt <= now) { presumed = true; continue; }
    if (!tight || window.usedPercent! > tight.usedPercent!) tight = window;
  }
  const confidence: Confidence = now - record.observedAt <= EXACT_MS && record.launchesSinceRead === 0 ? 'exact' : 'estimated';
  if (!tight) {
    return presumed
      ? { ...base, state: 'presumed-reset', remainingPercent: null, window: null, resetsAt: null, confidence: 'estimated', note: 'its windows probably reset since the last read' }
      : { ...base, state: 'unknown', remainingPercent: null, window: null, resetsAt: null, confidence: 'none', note: 'the provider gave no model windows' };
  }
  const remaining = Math.max(0, Math.round((100 - tight.usedPercent!) * 10) / 10);
  const view = { ...base, remainingPercent: remaining, window: tight.label, resetsAt: tight.resetsAt, confidence };
  if (remaining <= 0) return { ...view, state: 'exhausted', note: `${tight.label} used up${tight.resetsAt ? `; resets ${time(tight.resetsAt)}` : ''}` };
  const note = `${tight.label}: ${remaining}% left${tight.resetsAt ? `, resets ${time(tight.resetsAt)}` : ''}${record.launchesSinceRead ? `; ${record.launchesSinceRead} launch(es) since the read` : ''}`;
  if (presumed) return { ...view, state: 'presumed-reset', note: `${note}; another window probably reset since the read` };
  return { ...view, state: remaining < LOW_PERCENT ? 'low' : 'ok', note };
}

export interface ScheduleInput { record: QuotaRecord; now: number; random: number }

/** Delays (ms) the reader uses; all bounded. */
export const SCHEDULE = Object.freeze({
  minMs: 30_000,
  activeMs: 5 * 60_000,
  idleMs: 30 * 60_000,
  dormantMs: 60 * 60_000,
  exhaustedMs: 3 * 60_000,
  presumedMs: 30_000,
  /** Read again this long after a predicted reset. */
  afterResetMs: 20_000,
  /** A reset this close is waited for exactly instead of the regular interval. */
  nearResetMs: 15 * 60_000,
  failureBaseMs: 2 * 60_000,
  failureMaxMs: 60 * 60_000,
  /** "Active": a launch in the last half hour; "dormant": none in six hours (or never). */
  activeWindowMs: 30 * 60_000,
  dormantAfterMs: 6 * 3_600_000,
  jitter: 0.15
});

/**
 * When to read the account next: soon after a predicted reset and after an exhaustion, often while it is used,
 * rarely while idle, backing off on failures. `random` in [0, 1) spreads reads (jitter).
 */
export function nextReadAt({ record, now, random }: ScheduleInput): number {
  const last = Math.max(record.observedAt ?? 0, record.lastAttemptAt ?? 0);
  const jitter = (ms: number): number => Math.round(ms * (1 + SCHEDULE.jitter * (random * 2 - 1)));
  if (record.failures > 0) return last + jitter(Math.min(SCHEDULE.failureMaxMs, SCHEDULE.failureBaseMs * 2 ** Math.min(record.failures - 1, 10)));
  if (record.observedAt === null) return now;
  const view = viewOf(record, now);
  let delay: number;
  if (view.state === 'presumed-reset') delay = SCHEDULE.presumedMs;
  else if (view.state === 'exhausted') delay = SCHEDULE.exhaustedMs;
  else if (record.lastUseAt !== null && now - record.lastUseAt <= SCHEDULE.activeWindowMs) delay = SCHEDULE.activeMs;
  else if (record.lastUseAt === null || now - record.lastUseAt > SCHEDULE.dormantAfterMs) delay = SCHEDULE.dormantMs;
  else delay = SCHEDULE.idleMs;
  let at = last + jitter(delay);
  // A predicted reset before that: read just after it (to see the reset, or that it did not happen).
  const resets = [record.exhaustedUntil, ...record.windows.filter(window => window.models).map(window => window.resetsAt)]
    .filter((reset): reset is number => reset !== null && reset > now && reset - now <= SCHEDULE.nearResetMs);
  if (resets.length) at = Math.min(at, Math.min(...resets) + SCHEDULE.afterResetMs + Math.round(random * 10_000));
  return Math.max(at, last + SCHEDULE.minMs);
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const SOURCES: readonly QuotaSource[] = ['zai-quota-api', 'zai-limit-error', 'host-activity', 'core-limits'];

/** A saved record, rebuilt field by field (anything malformed is dropped). */
export function loadRecord(value: unknown): QuotaRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const record = emptyRecord();
  record.observedAt = num(raw.observedAt);
  record.source = SOURCES.find(source => source === raw.source) ?? null;
  record.plan = text(raw.plan, 60);
  record.exhaustedUntil = num(raw.exhaustedUntil);
  record.exhaustedOpen = raw.exhaustedOpen === true;
  record.exhaustedAt = num(raw.exhaustedAt);
  record.exhaustedByError = raw.exhaustedByError === true;
  record.lastAttemptAt = num(raw.lastAttemptAt);
  record.failures = Math.max(0, Math.min(num(raw.failures) ?? 0, 50));
  record.lastError = text(raw.lastError, 160);
  record.launchesSinceRead = Math.max(0, Math.min(num(raw.launchesSinceRead) ?? 0, 999));
  record.lastUseAt = num(raw.lastUseAt);
  if (Array.isArray(raw.windows)) for (const entry of raw.windows.slice(0, MAX_WINDOWS)) {
    if (!entry || typeof entry !== 'object') continue;
    const w = entry as Record<string, unknown>;
    const id = text(w.id, 60); const label = text(w.label, 40);
    if (!id || !label) continue;
    record.windows.push({ id, label, usedPercent: num(w.usedPercent), used: num(w.used), limit: num(w.limit), windowMinutes: num(w.windowMinutes), resetsAt: num(w.resetsAt), models: w.models !== false });
  }
  if (Array.isArray(raw.events)) for (const entry of raw.events.slice(-MAX_EVENTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const at = num(e.at); const note = text(e.note, 200);
    const kind = (['exhausted', 'early-reset', 'reset', 'recovered'] as const).find(k => k === e.kind);
    const early = Array.isArray(e.early) ? e.early.slice(0, MAX_WINDOWS).flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const d = entry as Record<string, unknown>;
      const window = text(d.window, 60); const before = num(d.usedBefore); const after = num(d.usedAfter); const announced = num(d.announcedResetAt);
      return window && before !== null && after !== null && announced !== null
        ? [{ window, usedBefore: before, usedAfter: after, announcedResetAt: announced, reportedResetAtAfter: num(d.reportedResetAtAfter), resetTimeKept: d.resetTimeKept === true }] : [];
    }) : [];
    if (at !== null && note !== null && kind) record.events.push({ at, kind, note, ...(early.length ? { early } : {}) });
  }
  return record;
}

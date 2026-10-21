/**
 * Z.AI / BigModel GLM Coding Plan quota: the shapes of `GET /api/monitor/usage/quota/limit` (the endpoint Z.AI's own
 * usage page and plan tools read) and of the limit errors the model API answers with. Pure parsing, no network.
 *
 * Sources (see quota-design.md): docs.z.ai/api-reference/api-code (error codes 1308, 1310, 1316–1321 with
 * `next_flush_time`, 1309/1314 expired, 1313 fair use); the response fields as read by open tools (CodexBar
 * docs/zai.md and Plugins/zai.js; opencode-glm-quota): `data.limits[]` with `type` TOKENS_LIMIT / CREDIT_LIMIT /
 * TIME_LIMIT, `unit` + `number` (unit 3 = hours, 6 = weeks, 1 = days, 5 = minutes; TIME_LIMIT 5/1 marks the
 * monthly MCP allowance), `percentage`, optional `usage`/`currentValue`/`remaining` counts, `nextResetTime` (epoch ms).
 */
import type { QuotaObservation, QuotaWindow } from './model.ts';

/** The hosts whose quota endpoint is known; an account is read only on its own host. */
export const ZAI_QUOTA_HOSTS: readonly string[] = Object.freeze(['api.z.ai', 'open.bigmodel.cn']);
export const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';

const MULTIPLIER: Record<number, number> = { 1: 1_440, 3: 60, 5: 1, 6: 10_080 };
const UNIT_NAME: Record<number, string> = { 1: 'd', 3: 'h', 5: 'min', 6: 'w' };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const int = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) ? value : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 10) / 10));

export class ZaiQuotaError extends Error {
  readonly kind: 'auth' | 'shape' | 'refused';
  constructor(message: string, kind: 'auth' | 'shape' | 'refused' = 'shape') { super(message); this.kind = kind; }
}

/** The quota answer's windows; throws ZaiQuotaError on a shape it does not know (never guesses 0 % used). */
export function parseZaiQuota(body: unknown, now: number): QuotaObservation {
  if (!isRecord(body)) throw new ZaiQuotaError('the quota answer is not an object');
  if (body.success === false || (body.code !== undefined && body.code !== 200 && body.code !== '200' && body.code !== 0)) {
    const code = typeof body.code === 'number' || typeof body.code === 'string' ? String(body.code).slice(0, 8) : '?';
    throw new ZaiQuotaError(`the quota endpoint answered code ${code}`, code === '401' || code === '1000' || code === '1001' || code === '1003' ? 'auth' : 'refused');
  }
  const data = isRecord(body.data) ? body.data : body;
  if (!Array.isArray(data.limits)) throw new ZaiQuotaError('the quota answer has no limits');
  const windows: QuotaWindow[] = [];
  for (const raw of data.limits.slice(0, 12)) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue;
    if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(raw.type)) continue;
    const unit = int(raw.unit); const number = int(raw.number);
    const percentage = finite(raw.percentage);
    const limit = int(raw.usage); const current = int(raw.currentValue); const remaining = int(raw.remaining);
    let used: number | null = null;
    if (limit !== null && limit > 0) {
      if (remaining !== null) used = Math.max(limit - remaining, current ?? limit - remaining);
      else if (current !== null) used = current;
    }
    const usedPercent = used !== null && limit ? clamp(Math.min(limit, Math.max(0, used)) / limit * 100) : percentage !== null ? clamp(percentage) : null;
    if (usedPercent === null) continue;
    const tools = raw.type === 'TIME_LIMIT';
    const minutes = tools && unit === 5 && number === 1 ? 30 * 1_440 : unit !== null && number !== null && number > 0 && MULTIPLIER[unit] ? number * MULTIPLIER[unit]! : null;
    // A reset further away than its window (plus skew) is not plausible: dropped, never "corrected" for a time zone.
    let resetsAt = int(raw.nextResetTime);
    if (resetsAt !== null && (resetsAt < now - 86_400_000 || (minutes !== null && resetsAt > now + (minutes + 1) * 60_000))) resetsAt = null;
    const label = tools ? 'MCP month' : minutes === 300 ? '5h' : minutes === 10_080 ? '7d' : unit !== null && number !== null && UNIT_NAME[unit] ? `${number}${UNIT_NAME[unit]}` : 'window';
    const id = tools ? 'zai:tools' : `zai:${raw.type === 'CREDIT_LIMIT' ? 'credits' : 'tokens'}:${minutes ?? 'x'}`;
    if (windows.some(window => window.id === id)) continue;
    windows.push({ id, label, usedPercent, used, limit: limit !== null && limit > 0 ? limit : null, windowMinutes: minutes, resetsAt, models: !tools });
  }
  if (!windows.some(window => window.models)) throw new ZaiQuotaError('the quota answer has no model windows');
  const plan = [data.planName, data.plan, data.level, data.packageName].find(value => typeof value === 'string' && /^[\w .+-]{1,40}$/u.test(value)) as string | undefined;
  return { source: 'zai-quota-api', at: now, windows, plan: plan ?? null };
}

/** Business codes that mean "used up until next_flush_time" (docs.z.ai api-code). */
const EXHAUSTED = new Set(['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']);
/** The plan is not usable at all until the person acts (expired, fair-use review). */
const BLOCKED = new Set(['1309', '1313', '1314']);

export interface ZaiLimit { code: string; kind: 'exhausted' | 'blocked'; until: number | null; zoneGuessed: boolean; windowMinutes: number }

/**
 * `YYYY-MM-DD HH:MM[:SS]` with an optional zone. Without a zone Z.AI's time is ambiguous (its servers are in UTC+8):
 * both readings are tried and the earlier one inside the window is kept (an early re-read costs less than a late one).
 */
export function parseFlushTime(text: string, now: number, windowMinutes: number): { at: number; zoneGuessed: boolean } | null {
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/u.exec(text);
  if (match) {
    const [, y, mo, d, h, mi, s, zone] = match;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    if (!Number.isFinite(utc)) return null;
    if (zone) {
      const offset = zone === 'Z' ? 0 : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * 60_000;
      return { at: utc - offset, zoneGuessed: false };
    }
    const latest = now + (windowMinutes + 1) * 60_000;
    const candidates = [utc, utc - 8 * 3_600_000].filter(at => at > now - 60_000 && at <= latest).sort((a, b) => a - b);
    return candidates.length ? { at: candidates[0]!, zoneGuessed: true } : null;
  }
  const epoch = /\b(1\d{9}|1\d{12})\b/u.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    return { at: value < 1e12 ? value * 1_000 : value, zoneGuessed: false };
  }
  return null;
}

/**
 * A Z.AI limit error from an answer body (JSON `{error:{code,message}}` or `{code,msg}`) or an agent's text output.
 * null: not a quota limit (a plain rate limit 1302/1305 is not one).
 */
export function parseZaiLimitError(input: unknown, now: number): ZaiLimit | null {
  let code: string | null = null;
  let message = '';
  const take = (value: unknown): void => {
    if (!isRecord(value)) return;
    const inner = isRecord(value.error) ? value.error : value;
    if (typeof inner.code === 'string' || typeof inner.code === 'number') code = String(inner.code);
    const text = inner.message ?? inner.msg;
    if (typeof text === 'string') message = text.slice(0, 600);
  };
  if (typeof input === 'string') {
    const trimmed = input.slice(0, 4_000);
    try { take(JSON.parse(trimmed)); } catch { /* text */ }
    if (!code) {
      // Plain text (an agent's output): the code counts only next to Z.AI's own wording.
      const found = /["'\s(:]?(13(?:0[89]|1[0-9]|2[01]))["'\s),:]/u.exec(` ${trimmed} `);
      if (found && /usage limit reached|limit exhausted|limit will reset|resets at|package has expired|fair usage/iu.test(trimmed)) code = found[1]!;
      message = trimmed;
    }
  } else take(input);
  if (!code) return null;
  const windowMinutes = /\b(?:7 days|week|weekly)\b/iu.test(message) || ['1310', '1317', '1319', '1321'].includes(code) ? 10_080 : 300;
  if (BLOCKED.has(code)) return { code, kind: 'blocked', until: null, zoneGuessed: false, windowMinutes };
  if (!EXHAUSTED.has(code)) return null;
  const flush = parseFlushTime(message, now, code === '1310' ? 31 * 1_440 : windowMinutes);
  return { code, kind: 'exhausted', until: flush?.at ?? null, zoneGuessed: flush?.zoneGuessed ?? false, windowMinutes };
}

/** A limit error as an observation for the quota record. */
export const limitObservation = (limit: ZaiLimit, now: number): QuotaObservation =>
  ({ source: 'zai-limit-error', at: now, windows: [], exhausted: { until: limit.until, code: limit.code, ...(limit.zoneGuessed ? { zoneGuessed: true } : {}) } });

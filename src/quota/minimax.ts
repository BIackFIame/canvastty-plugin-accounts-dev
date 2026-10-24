/**
 * MiniMax Coding/Token Plan quota: `GET https://<api host>/v1/token_plan/remains` with the plan key as a Bearer token.
 * Pure parsing, no network.
 *
 * Sources: MiniMax's Token Plan FAQ (platform.minimax.io/docs/token-plan/faq, "How to check Token Plan usage": the
 * endpoint, a 5-hour and a weekly window per model family); the first-party MiniMax-AI/cli (commit 38aba5f, 2026-10-19):
 * src/client/endpoints.ts (`${baseUrl}/v1/token_plan/remains`; keys starting `sk-api-` are pay-as-you-go keys that read
 * a balance instead), src/config/schema.ts (api.minimax.io, api.minimax.cn), src/types/api.ts (QuotaModelRemain),
 * src/utils/quota.ts (older answers count the remaining calls in `*_usage_count`, newer ones the used calls; an explicit
 * `*_remaining_percent` decides) and src/output/quota-table.ts (status 1 normal, 2 used up, 3 unlimited; both totals 0 and
 * both statuses 3: the model family is not in the plan).
 */
import type { QuotaObservation, QuotaWindow } from './model.ts';
import { ZaiQuotaError } from './zai.ts';

export const MINIMAX_QUOTA_HOSTS: readonly string[] = Object.freeze(['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com']);
export const MINIMAX_QUOTA_PATH = '/v1/token_plan/remains';
/** A pay-as-you-go key (MiniMax-AI/cli isSecretApiKey): it has no plan quota to read. */
export const minimaxPayAsYouGoKey = (key: string): boolean => key.startsWith('sk-api-');

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 10) / 10));

/** The model families that carry coding calls (text models); speech, image and video buckets never block a route. */
const textFamily = (name: string): boolean => /^minimax-m|^general$|^text/iu.test(name);

/** Used share of one window, or null when the answer does not say it (never guessed as 0). */
function usedPercentOf(count: number | null, total: number | null, remainingPercent: number | null, status: number | null): number | null {
  if (status === 2) return 100;
  if (remainingPercent !== null) return clamp(100 - Math.min(100, remainingPercent));
  if (count === null || total === null || total <= 0 || count < 0 || count > total) return null;
  // Without a percentage the older meaning holds: the count is what is left (MiniMax-AI/cli resolveQuotaCounts).
  return clamp((total - count) / total * 100);
}

export function parseMiniMaxQuota(body: unknown, now: number): QuotaObservation {
  if (!isRecord(body)) throw new ZaiQuotaError('the quota answer is not an object');
  const base = isRecord(body.base_resp) ? body.base_resp : null;
  const code = base ? finite(base.status_code) : null;
  if (code !== null && code !== 0) throw new ZaiQuotaError(`the quota endpoint answered code ${String(code).slice(0, 8)}`, code === 1004 || code === 2049 ? 'auth' : 'refused');
  if (!Array.isArray(body.model_remains)) throw new ZaiQuotaError('the quota answer has no model_remains');
  const windows: QuotaWindow[] = [];
  for (const raw of body.model_remains.slice(0, 16)) {
    if (!isRecord(raw) || typeof raw.model_name !== 'string') continue;
    const name = raw.model_name.slice(0, 40);
    const models = textFamily(name);
    const family = models ? 'text' : name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').slice(0, 20);
    const intervalTotal = finite(raw.current_interval_total_count);
    const weeklyTotal = finite(raw.current_weekly_total_count);
    const intervalStatus = finite(raw.current_interval_status);
    const weeklyStatus = finite(raw.current_weekly_status);
    if (intervalTotal === 0 && weeklyTotal === 0 && intervalStatus === 3 && weeklyStatus === 3) continue; // not in the plan
    const slots = [
      { kind: 'interval', total: intervalTotal, count: finite(raw.current_interval_usage_count), percent: finite(raw.current_interval_remaining_percent), status: intervalStatus, start: finite(raw.start_time), end: finite(raw.end_time) },
      { kind: 'weekly', total: weeklyTotal, count: finite(raw.current_weekly_usage_count), percent: finite(raw.current_weekly_remaining_percent), status: weeklyStatus, start: finite(raw.weekly_start_time), end: finite(raw.weekly_end_time) }
    ];
    for (const slot of slots) {
      // Unlimited, or a window the plan does not have (a total of 0 without a status).
      if (slot.status === 3 || (slot.total === 0 && slot.status === null)) continue;
      const usedPercent = usedPercentOf(slot.count, slot.total, slot.percent, slot.status);
      if (usedPercent === null) continue;
      const minutes = slot.start !== null && slot.end !== null && slot.end > slot.start ? Math.round((slot.end - slot.start) / 60_000) : slot.kind === 'weekly' ? 10_080 : 300;
      let resetsAt = slot.end !== null && slot.end > 1e12 ? slot.end : null;
      if (resetsAt !== null && (resetsAt < now - 86_400_000 || resetsAt > now + (minutes + 1) * 60_000)) resetsAt = null;
      const total = slot.total !== null && slot.total > 0 ? slot.total : null;
      const id = `minimax:${family}:${slot.kind === 'weekly' ? 'weekly' : minutes}`;
      if (windows.some(window => window.id === id)) continue;
      windows.push({
        id, label: `${models ? '' : `${name} `}${slot.kind === 'weekly' ? '7d' : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}`.trim(),
        usedPercent, used: total !== null ? Math.round(total * usedPercent / 100) : null, limit: total, windowMinutes: minutes, resetsAt, models
      });
    }
  }
  if (!windows.some(window => window.models)) throw new ZaiQuotaError('the quota answer has no text-model window');
  return { source: 'minimax-quota-api', at: now, windows, plan: null };
}

/**
 * A MiniMax limit error (an HTTP 429 body, or `base_resp` with a usage-limit code): used up, no reset time given. null
 * when it is not one. MiniMax documents no reset field in these answers, so the window's own reset (from the last read)
 * or a fresh read decides when the account is offered again.
 */
export function parseMiniMaxLimitError(input: unknown): { code: string } | null {
  let text = '';
  let code: string | null = null;
  if (typeof input === 'string') {
    text = input.slice(0, 4_000);
    try { input = JSON.parse(text); } catch { /* text */ }
  }
  if (isRecord(input)) {
    const base = isRecord(input.base_resp) ? input.base_resp : isRecord(input.error) ? input.error : input;
    const value = base.status_code ?? base.code;
    if (typeof value === 'number' || typeof value === 'string') code = String(value).slice(0, 8);
    const message = base.status_msg ?? base.message ?? base.msg;
    if (typeof message === 'string') text = message.slice(0, 600);
  }
  if (/usage limit|quota (?:is )?(?:exceeded|exhausted|used up)|token plan.*(?:limit|exhausted)|coding plan.*(?:limit|exhausted)/iu.test(text)) return { code: code ?? 'limit' };
  return null;
}

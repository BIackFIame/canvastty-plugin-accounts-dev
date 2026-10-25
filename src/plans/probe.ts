/**
 * Quick add's region probe: which host of a coding plan the person's key belongs to, found with the plan's own quota
 * read (the monitoring endpoint the quota reader already polls), never a model request, so no tokens are spent.
 *
 * Order: the international host first; the China host only when the international one refused the key (HTTP 401/403,
 * or the plan's own "invalid key" code in a 200 answer). Anything else (no answer, a timeout, a server error) stops
 * the probe with that reason: the key is never sent to a second host because the first one was down. Each request
 * goes to the plan's own host only (redirects refused), 10 s at most, answers up to 256 KB; the key never appears in
 * a result, a log or an error.
 */
import type { QuotaObservation } from '../quota/model.ts';
import type { QuotaFetch } from '../quota/reader.ts';
import { limitObservation, parseZaiLimitError, parseZaiQuota, ZaiQuotaError, ZAI_QUOTA_PATH } from '../quota/zai.ts';
import { MINIMAX_QUOTA_PATH, minimaxPayAsYouGoKey, parseMiniMaxLimitError, parseMiniMaxQuota } from '../quota/minimax.ts';
import { PLAN_INFO, type PlanProvider, type PlanRegion } from './plans.ts';

const REQUEST_MS = 10_000;
const MAX_BODY = 256 * 1_024;

/** The quota read of each plan (the same paths as quota/reader.ts). */
export const PROBE_PATHS: Readonly<Record<PlanProvider, string>> = Object.freeze({ glm: ZAI_QUOTA_PATH, minimax: MINIMAX_QUOTA_PATH });

export interface ProbeTry { region: PlanRegion; host: string; outcome: 'ok' | 'refused-key' | 'error'; status: number | null }
export type ProbeResult =
  | { ok: true; region: PlanRegion; host: string; observation: QuotaObservation | null; tried: ProbeTry[] }
  | { ok: false; reason: 'key-refused' | 'unreachable' | 'error' | 'pay-as-you-go'; message: string; tried: ProbeTry[] };

/** One host's answer, classified. */
type Answer = { kind: 'ok'; observation: QuotaObservation | null } | { kind: 'refused-key' } | { kind: 'error'; message: string; unreachable: boolean };

/** A "used up" answer as an observation (the key is the plan's on this host; only its quota is gone). */
function limitOf(provider: PlanProvider, body: unknown, at: number): QuotaObservation | null {
  if (provider === 'glm') {
    const limit = parseZaiLimitError(body, at);
    return limit && limit.kind === 'exhausted' ? limitObservation(limit, at) : null;
  }
  const found = parseMiniMaxLimitError(body);
  return found ? { source: 'minimax-limit-error', at, windows: [], exhausted: { until: null, code: found.code } } : null;
}

async function ask(provider: PlanProvider, host: string, key: string, fetcher: QuotaFetch, now: () => number): Promise<{ answer: Answer; status: number | null }> {
  const url = `https://${host}${PROBE_PATHS[provider]}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_MS);
  timer.unref?.();
  let status: number | null = null;
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    status = response.status;
    const body = (await response.text()).slice(0, MAX_BODY);
    if (status === 401 || status === 403) return { answer: { kind: 'refused-key' }, status };
    const at = now();
    let json: unknown = null;
    try { json = JSON.parse(body); } catch { json = null; }
    if (status >= 400) {
      // A limit answer means the key is the plan's on this host (only its quota is used up).
      const observation = limitOf(provider, json ?? body, at);
      if (observation) return { answer: { kind: 'ok', observation }, status };
      return { answer: { kind: 'error', message: `${host} answered HTTP ${status}`, unreachable: status >= 500 }, status };
    }
    if (json === null) return { answer: { kind: 'error', message: `${host} did not answer with JSON`, unreachable: false }, status };
    const limited = limitOf(provider, json, at);
    if (limited) return { answer: { kind: 'ok', observation: limited }, status };
    try {
      return { answer: { kind: 'ok', observation: provider === 'glm' ? parseZaiQuota(json, at) : parseMiniMaxQuota(json, at) }, status };
    } catch (error) {
      // The plan's own "invalid key" code in a 200 answer is a refusal like 401; any other answer means the host took the key.
      if (error instanceof ZaiQuotaError && error.kind === 'auth') return { answer: { kind: 'refused-key' }, status };
      return { answer: { kind: 'ok', observation: null }, status };
    }
  } catch {
    return { answer: { kind: 'error', message: controller.signal.aborted ? `${host} did not answer in time` : `${host} could not be reached`, unreachable: true }, status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The region the key belongs to. `only` limits the probe to one region (the person chose it under «Дополнительно»).
 * A MiniMax pay-as-you-go key (`sk-api-…`) has no plan quota: nothing is sent.
 */
export async function probePlanRegion(input: { provider: PlanProvider; key: string; fetch: QuotaFetch; now?: () => number; only?: PlanRegion }): Promise<ProbeResult> {
  const { provider, key } = input;
  const now = input.now ?? Date.now;
  const info = PLAN_INFO[provider];
  if (provider === 'minimax' && minimaxPayAsYouGoKey(key)) {
    return { ok: false, reason: 'pay-as-you-go', message: 'This is a MiniMax pay-as-you-go key (sk-api-…), not a Coding Plan key: it has no plan quota. Add it as a model account (MiniMax preset) instead.', tried: [] };
  }
  const regions: PlanRegion[] = input.only ? [input.only] : ['intl', 'cn'];
  const tried: ProbeTry[] = [];
  for (const region of regions) {
    const host = info.regions[region].host;
    const { answer, status } = await ask(provider, host, key, input.fetch, now);
    tried.push({ region, host, outcome: answer.kind, status });
    if (answer.kind === 'ok') return { ok: true, region, host, observation: answer.observation, tried };
    if (answer.kind === 'error') {
      const scrubbed = answer.message.split(key).join('[key]');
      return { ok: false, reason: answer.unreachable ? 'unreachable' : 'error', message: `${scrubbed}; nothing was saved. Try again, or choose the region under «Дополнительно».`, tried };
    }
  }
  return { ok: false, reason: 'key-refused', message: `The key was refused by ${tried.map(entry => entry.host).join(' and ')}; nothing was saved.`, tried };
}

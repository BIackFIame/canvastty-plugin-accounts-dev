/**
 * Coding-plan subscriptions: GLM Coding Plan (Z.AI international, BigModel China) and MiniMax Coding/Token Plan
 * (international, China). Unlike the CLI sign-ins in pools, a plan is an API key the person pastes, so a plan account
 * is a model account on the plan's own host (the same storage, the key in `key.<id>` bound to that host): an account
 * saved earlier with a Z.AI or MiniMax preset is a plan account without being entered again. Pure tables and checks.
 *
 * Endpoints (checked 2026-10-24 against the providers' own pages):
 * - GLM: docs.z.ai/devpack/quick-start (api.z.ai: /api/anthropic, /api/coding/paas/v4), docs.bigmodel.cn/cn/coding-plan/
 *   quick-start (open.bigmodel.cn: the same paths); models GLM-5.3 and GLM-5.3-Flash (docs.z.ai/devpack/tool/claude).
 * - MiniMax: platform.minimax.io/docs/token-plan/opencode (api.minimax.io: /anthropic, /v1), platform.minimax.cn/docs/
 *   token-plan/claude-code (api.minimax.cn/anthropic); model MiniMax-M3.1-Flash. api.minimaxi.com is MiniMax's older
 *   China host, still recognised for accounts saved with it.
 * A key is a plan's, so parallel cards on one account are fine (no refresh token to rotate); a per-account cap bounds them.
 */
import type { Account, Harness, PresetId } from '../shared/accounts.ts';

export const PLAN_PROVIDERS = ['glm', 'minimax'] as const;
export type PlanProvider = typeof PLAN_PROVIDERS[number];
export type PlanRegion = 'intl' | 'cn';
/** The agents a plan pool launches (both speak the plan's Anthropic-compatible endpoint). */
export const PLAN_HARNESSES: readonly Harness[] = Object.freeze(['claude', 'opencode']);
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 16;
export const PLAN_VALUE = 'pool:';

export interface PlanRegionInfo { host: string; label: { en: string; ru: string } }
export interface PlanInfo {
  label: string;
  /** Paths on the plan's host. */
  anthropicPath: string;
  openaiPath: string;
  regions: Readonly<Record<PlanRegion, PlanRegionInfo>>;
  /** Hosts saved earlier that are still this plan (region by host). */
  legacyHosts: Readonly<Record<string, PlanRegion>>;
  model: string;
  smallModel: string;
  /** The model-account preset a plan account is saved with. */
  preset: PresetId;
  presets: readonly PresetId[];
}

export const PLAN_INFO: Readonly<Record<PlanProvider, PlanInfo>> = Object.freeze({
  glm: {
    label: 'GLM Coding Plan', anthropicPath: '/api/anthropic', openaiPath: '/api/coding/paas/v4',
    regions: { intl: { host: 'api.z.ai', label: { en: 'Z.AI (international)', ru: 'Z.AI (международный)' } }, cn: { host: 'open.bigmodel.cn', label: { en: 'BigModel (China)', ru: 'BigModel (Китай)' } } },
    legacyHosts: {}, model: 'glm-5.3', smallModel: 'glm-5.3-flash', preset: 'zai-anthropic', presets: ['zai-anthropic', 'zai-openai']
  },
  minimax: {
    label: 'MiniMax Coding Plan', anthropicPath: '/anthropic', openaiPath: '/v1',
    regions: { intl: { host: 'api.minimax.io', label: { en: 'minimax.io (international)', ru: 'minimax.io (международный)' } }, cn: { host: 'api.minimax.cn', label: { en: 'minimax.cn (China)', ru: 'minimax.cn (Китай)' } } },
    legacyHosts: { 'api.minimaxi.com': 'cn' }, model: 'MiniMax-M3.1-Flash', smallModel: 'MiniMax-M3.1-Flash', preset: 'minimax-anthropic', presets: ['minimax-anthropic', 'minimax-openai']
  }
});

export const isPlanProvider = (value: unknown): value is PlanProvider => typeof value === 'string' && (PLAN_PROVIDERS as readonly string[]).includes(value);
export const isPlanRegion = (value: unknown): value is PlanRegion => value === 'intl' || value === 'cn';

const httpsHost = (url: string): string | null => {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.port ? parsed.hostname.toLowerCase() : null; } catch { return null; }
};

export interface PlanOf { provider: PlanProvider; region: PlanRegion; host: string }

/** The plan an account belongs to: an API account on a plan's own host (https, default port), or null. */
export function planOf(account: Pick<Account, 'preset' | 'baseUrl'>): PlanOf | null {
  const host = httpsHost(account.baseUrl);
  if (!host) return null;
  for (const provider of PLAN_PROVIDERS) {
    const info = PLAN_INFO[provider];
    if (!info.presets.includes(account.preset) && !['custom-anthropic', 'custom-openai'].includes(account.preset)) continue;
    for (const region of ['intl', 'cn'] as const) if (info.regions[region].host === host) return { provider, region, host };
    const legacy = info.legacyHosts[host];
    if (legacy) return { provider, region: legacy, host };
  }
  return null;
}

/** The plan's endpoints on the account's own host (so the key is only ever sent where it was saved for). */
export function planEndpoints(plan: PlanOf): { anthropic: string; openai: string; origin: string } {
  const info = PLAN_INFO[plan.provider];
  return { anthropic: `https://${plan.host}${info.anthropicPath}`, openai: `https://${plan.host}${info.openaiPath}`, origin: `https://${plan.host}` };
}

/** The agents a plan account runs: Claude Code and OpenCode on the plan endpoint, plus any others the account allows. */
export function planHarnesses(account: Pick<Account, 'agents'>): Harness[] {
  return [...new Set<Harness>([...PLAN_HARNESSES, ...account.agents])];
}

/**
 * The account as a launch of `harness` sees it: Claude Code and OpenCode use the plan's Anthropic endpoint on the
 * account's own host (an account saved with the OpenAI preset included); other agents keep the account as saved.
 */
export function planLaunchAccount(account: Account, harness: Harness): Account {
  const plan = planOf(account);
  if (!plan || !PLAN_HARNESSES.includes(harness)) return account;
  return { ...account, preset: PLAN_INFO[plan.provider].preset, baseUrl: planEndpoints(plan).anthropic, responsesApi: undefined } as Account;
}

export const concurrencyOf = (account: Pick<Account, 'concurrency'>): number => account.concurrency ?? DEFAULT_CONCURRENCY;

/** A new plan account (the service validates it with the rest). */
export function newPlanAccount(input: { id: string; provider: PlanProvider; region: PlanRegion; label: string; trust: Account['trust']; concurrency?: number; brokerable?: boolean }): Account {
  const info = PLAN_INFO[input.provider];
  return {
    id: input.id, label: input.label, preset: info.preset, baseUrl: `https://${info.regions[input.region].host}${info.anthropicPath}`,
    model: info.model, ...(info.smallModel !== info.model ? { smallModel: info.smallModel } : {}), agents: ['claude', 'opencode'],
    trust: input.trust ?? 'unset', ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}), ...(input.brokerable ? { brokerable: true } : {})
  };
}

/**
 * Coding-plan model lists: which models a plan account can run, and which of them it runs by default. Pure: the
 * reader (plans/modelReader.ts) fetches, the service decides from these functions, the page and the tests use them too.
 *
 * Where a list comes from, in order:
 * 1. The account's own list, read with its key from the plan's OpenAI-compatible `GET <openai path>/models` on the
 *    account's own host (never another host), at most once a day and on "Read now".
 *    - MiniMax documents it: GET https://api.minimax.io/v1/models, Bearer key, `{ object: "list", data: [{ id, object,
 *      created, owned_by }] }` (platform.minimax.io/docs/api-reference/models/openai/list-models; the China docs at
 *      platform.minimaxi.com have the same endpoint). It lists the platform's models (video and speech too), so only
 *      the M text models are kept.
 *    - GLM documents no model list (docs.z.ai/llms.txt and docs.bigmodel.cn/llms.txt name none, checked 2026-10-25),
 *      so the plan's coding endpoint is asked the OpenAI way (`/api/coding/paas/v4/models`); a 404 or any other answer
 *      that is not such a list falls back to the bundled list without an error for the person.
 * 2. The bundled list below, from the providers' own pages (checked 2026-10-25):
 *    - GLM Coding Plan: "All plans support GLM-5.3, GLM-5.3-Flash" (docs.z.ai/devpack/faq, docs.z.ai/devpack/overview);
 *      the API ids are glm-5.3 and glm-5.3-flash (docs.z.ai/devpack/latest-model). GLM-5.1 and GLM-5.2 requests are
 *      routed to GLM-5.3, GLM-4.7 to GLM-5.3-Flash.
 *    - MiniMax: available LLMs MiniMax-M3.1-Flash and MiniMax-M3; M2, M2.1, M2.5, M2.7 (and -highspeed) retired, plan
 *      requests for M2.5/M2.7 routed to M3.1 Flash from 2026-10-19 (platform.minimax.io/docs/faq/models).
 * The plugin uses no model catalog (models.dev or another), so there is no third source.
 *
 * The default: the newest stable model that is not a small variant for the main slots, the newest small variant
 * (Flash, Air, …) for Claude Code's Haiku slot and OpenCode's small_model. "Newest" is the highest version number;
 * at the same version the plain id wins over variants (glm-5.3 over glm-5.3-prime, -flash over -flashx).
 * Per plan (MAIN_IS_SMALL): MiniMax's main slots also run its newest Flash, the model MiniMax's own Claude Code setup
 * names (platform.minimax.io/docs/token-plan/opencode) and the one its plans route retired models to (the owner's
 * choice, 2026-10-25).
 */
import type { PlanProvider } from './plans.ts';

export const BUNDLED_MODELS: Readonly<Record<PlanProvider, readonly string[]>> = Object.freeze({
  glm: Object.freeze(['glm-5.3', 'glm-5.3-flash']),
  minimax: Object.freeze(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
});
/** Plans whose main slots run the newest small (Flash) model too, while the list has one. */
const MAIN_IS_SMALL: Readonly<Record<PlanProvider, boolean>> = Object.freeze({ glm: false, minimax: true });
/**
 * Main models an earlier build of this plugin chose by default: an account that did not choose a model moves off them
 * without a notice of its own (the page already said it moved).
 */
export const FORMER_DEFAULTS: Readonly<Record<PlanProvider, readonly string[]>> = Object.freeze({ glm: Object.freeze([]), minimax: Object.freeze(['MiniMax-M3']) });
/** When the bundled list was checked against the providers' pages (shown with it). */
export const BUNDLED_CHECKED = '2026-10-25';

export const MAX_MODELS = 64;
const MAX_ID = 100;

/** A text model id of the plan's family: `glm-<version>[-variant…]`, `MiniMax-M<version>[-variant…]`. */
const FAMILY: Readonly<Record<PlanProvider, RegExp>> = Object.freeze({
  glm: /^glm-(\d+(?:\.\d+)*)((?:-[a-z0-9]+)*)$/iu,
  minimax: /^minimax-m(\d+(?:\.\d+)*)((?:-[a-z0-9]+)*)$/iu
});
/** Variants that are the small, fast model of a version. */
const SMALL = ['flash', 'air', 'flashx', 'airx', 'mini', 'lite', 'nano', 'small'];
/** Variants that are not for default use (still listed, still choosable). */
const UNSTABLE = new Set(['preview', 'beta', 'alpha', 'exp', 'experimental', 'test']);
/** Not text generation (an id of the family that is something else). */
const NOT_TEXT = new Set(['ocr', 'image', 'asr', 'tts', 'embedding', 'realtime', 'voice', 'video', 'vision', 'audio', 'rerank']);

export interface ParsedModel { id: string; version: number[]; variants: string[]; small: boolean; stable: boolean }

/** The id as a plan model, or null when it is not one of the plan's text models. */
export function parseModel(provider: PlanProvider, id: string): ParsedModel | null {
  if (typeof id !== 'string' || !id || id.length > MAX_ID) return null;
  const match = FAMILY[provider].exec(id);
  if (!match) return null;
  const variants = match[2]!.toLowerCase().split('-').filter(Boolean);
  if (variants.some(variant => NOT_TEXT.has(variant))) return null;
  return {
    id, version: match[1]!.split('.').map(Number), variants,
    small: variants.some(variant => SMALL.includes(variant)), stable: !variants.some(variant => UNSTABLE.has(variant))
  };
}

const compareVersion = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
};
const smallRank = (model: ParsedModel): number => Math.min(...model.variants.map(variant => SMALL.indexOf(variant)).filter(rank => rank >= 0), SMALL.length);

/** Best first: stable before unstable, higher version, fewer variants (the plain id), the commoner small variant. */
function better(a: ParsedModel, b: ParsedModel): number {
  if (a.stable !== b.stable) return a.stable ? -1 : 1;
  const version = compareVersion(b.version, a.version);
  if (version) return version;
  if (a.variants.length !== b.variants.length) return a.variants.length - b.variants.length;
  const rank = smallRank(a) - smallRank(b);
  return rank || a.id.localeCompare(b.id);
}

/** The plan's text models in a provider's answer (OpenAI `{ data: [{ id }] }`, as MiniMax documents it); null if none. */
export function parseModelList(provider: PlanProvider, body: unknown): string[] | null {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return null;
  const seen = new Set<string>();
  const models: string[] = [];
  for (const entry of data.slice(0, 1_000)) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || /[^A-Za-z0-9._-]/u.test(id) || !parseModel(provider, id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    models.push(id);
  }
  return models.length ? sortModels(provider, models).slice(0, MAX_MODELS) : null;
}

/** Newest first, the main models of a version before its small ones; ids that are not the plan's at the end. */
export function sortModels(provider: PlanProvider, models: readonly string[]): string[] {
  const parsed = models.map(id => ({ id, model: parseModel(provider, id) }));
  return parsed.sort((a, b) => {
    if (!a.model || !b.model) return a.model ? -1 : b.model ? 1 : 0;
    if (a.model.stable !== b.model.stable) return a.model.stable ? -1 : 1;
    const version = compareVersion(b.model.version, a.model.version);
    if (version) return version;
    if (a.model.small !== b.model.small) return a.model.small ? 1 : -1;
    return better(a.model, b.model);
  }).map(entry => entry.id);
}

/** The defaults of a list: the newest main model, and the newest small one (the main one when the list has none). */
export function defaultModels(provider: PlanProvider, models: readonly string[]): { model: string; smallModel: string } {
  const parsed = models.map(id => parseModel(provider, id)).filter((model): model is ParsedModel => model !== null);
  const pool = parsed.length ? parsed : BUNDLED_MODELS[provider].map(id => parseModel(provider, id)!);
  const mains = pool.filter(model => !model.small).sort(better);
  const smalls = pool.filter(model => model.small).sort(better);
  const main = (MAIN_IS_SMALL[provider] ? smalls[0] : undefined) ?? mains[0] ?? smalls[0]!;
  return { model: main.id, smallModel: (smalls[0] ?? main).id };
}

/** The list's own spelling of `wanted` (ids are compared without case), or null when the list does not have it. */
export function listed(models: readonly string[], wanted: string): string | null {
  const lower = wanted.toLowerCase();
  return models.find(id => id.toLowerCase() === lower) ?? null;
}

/** An id of the plan's family older than every model on the list (glm-4.6 next to glm-5.3): retired or routed. */
export function olderThanList(provider: PlanProvider, models: readonly string[], id: string): boolean {
  const model = parseModel(provider, id);
  if (!model || listed(models, id)) return false;
  const versions = models.map(entry => parseModel(provider, entry)).filter((entry): entry is ParsedModel => entry !== null).map(entry => entry.version);
  return versions.length > 0 && versions.every(version => compareVersion(model.version, version) < 0);
}

/** What the page and readers are told about a plan account's list. */
export interface PlanModelList {
  models: string[];
  /** `live`: the account's own list from its host; `bundled`: the plugin's list (no live list yet, or it failed). */
  source: 'live' | 'bundled';
  /** When the live list was read (ms), if ever. */
  readAt: number | null;
  /** Why the bundled list is used, when a read was tried. */
  note: string | null;
  defaults: { model: string; smallModel: string };
}

export function bundledList(provider: PlanProvider, note: string | null = null): PlanModelList {
  const models = sortModels(provider, BUNDLED_MODELS[provider]);
  return { models, source: 'bundled', readAt: null, note, defaults: defaultModels(provider, models) };
}

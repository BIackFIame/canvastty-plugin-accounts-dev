/**
 * Model accounts: one agent CLI (harness) on one model behind an API endpoint or an Ollama server (L22 «любой агент с
 * любой моделью»). Pure: the service, the settings page and the tests decide from the same tables.
 *
 * An account never replaces an agent's own CLI sign-in: it is used only for a launch that names it (the launcher's
 * "Model account", or an orchestrator's spawn_agent launchOptions).
 */
import { parseOllamaModelRef, validOllamaModelName } from './ollamaModelRef.ts';

/** The agent CLIs an account can drive, each through per-run environment, flags and files CanvasTTY owns. */
export const HARNESSES = ['claude', 'codex', 'opencode', 'qwen', 'kimi'] as const;
export type Harness = typeof HARNESSES[number];
export const HARNESS_LABELS: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', qwen: 'Qwen Code', kimi: 'Kimi' };

export type Protocol = 'anthropic' | 'openai' | 'ollama';
export type OllamaShape = 'local' | 'cloud-local' | 'cloud-direct';

export type PresetId =
  | 'ollama-local' | 'ollama-cloud-local' | 'ollama-cloud'
  | 'zai-anthropic' | 'zai-openai' | 'minimax-anthropic' | 'minimax-openai'
  | 'openrouter-openai' | 'openrouter-anthropic' | 'custom-anthropic' | 'custom-openai';

export interface Preset {
  id: PresetId;
  label: string;
  protocol: Protocol;
  /** null: the person types the address. */
  baseUrl: string | null;
  /** For Ollama presets. */
  ollama?: OllamaShape;
  /** A model to start from (the person changes it). */
  model: string;
}

export const OLLAMA_LOCAL_URL = 'http://127.0.0.1:11434';
export const OLLAMA_CLOUD_URL = 'https://ollama.com';

export const PRESETS: readonly Preset[] = Object.freeze([
  { id: 'ollama-local', label: 'Ollama · this computer', protocol: 'ollama', baseUrl: OLLAMA_LOCAL_URL, ollama: 'local', model: 'qwen3.5:9b' },
  { id: 'ollama-cloud-local', label: 'Ollama Cloud · through this computer\'s Ollama', protocol: 'ollama', baseUrl: OLLAMA_LOCAL_URL, ollama: 'cloud-local', model: 'gpt-oss:120b-cloud' },
  { id: 'ollama-cloud', label: 'Ollama Cloud · ollama.com key', protocol: 'ollama', baseUrl: OLLAMA_CLOUD_URL, ollama: 'cloud-direct', model: 'gpt-oss:120b' },
  { id: 'zai-anthropic', label: 'Z.AI · Anthropic API', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6' },
  { id: 'zai-openai', label: 'Z.AI · OpenAI API', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  { id: 'minimax-anthropic', label: 'MiniMax · Anthropic API', protocol: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2' },
  { id: 'minimax-openai', label: 'MiniMax · OpenAI API', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M2' },
  { id: 'openrouter-openai', label: 'OpenRouter · OpenAI API', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6' },
  { id: 'openrouter-anthropic', label: 'OpenRouter · Anthropic API', protocol: 'anthropic', baseUrl: 'https://openrouter.ai/api', model: 'z-ai/glm-4.6' },
  { id: 'custom-anthropic', label: 'Other Anthropic-compatible API', protocol: 'anthropic', baseUrl: null, model: '' },
  { id: 'custom-openai', label: 'Other OpenAI-compatible API', protocol: 'openai', baseUrl: null, model: '' }
] satisfies Preset[]);

/**
 * The owner's rule: OpenRouter carries only the Assistant's Jev decision calls, never model traffic. An account whose
 * endpoint is openrouter.ai or a subdomain (the OpenRouter presets, or a custom address there) may still run an agent the
 * person starts themselves, but never a delegated launch (a subagent), and it is never offered as a route. An address
 * that does not parse counts as one (fail closed).
 */
export function isDecisionOnlyHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/u, ''); } catch { return true; }
  return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}
export const decisionsOnlyAccount = (account: Pick<Account, 'preset' | 'baseUrl'>): boolean =>
  account.preset === 'openrouter-openai' || account.preset === 'openrouter-anthropic' || isDecisionOnlyHost(account.baseUrl);
export const DECISIONS_ONLY_REASON = 'OpenRouter is for Jev\'s decisions only: model traffic never goes to openrouter.ai';

export interface Account {
  /** `[a-z0-9][a-z0-9-]{0,39}`; the key is the plugin secret `key.<id>`. */
  id: string;
  label: string;
  preset: PresetId;
  baseUrl: string;
  model: string;
  /** OpenAI-compatible only: the endpoint speaks the Responses API, which Codex needs. */
  responsesApi?: boolean;
  /** The agent CLIs the person allows on this account (each one supported by its protocol). */
  agents: Harness[];
  /**
   * The person lets other extensions send single model requests through this account (CanvasTTY's brokered
   * requests: CanvasTTY adds the key itself, the other extension never sees it, and the person still allows each
   * extension in CanvasTTY's settings). Off unless the person ticks it; only API accounts with a key, never OpenRouter.
   */
  brokerable?: boolean;
}

export interface AccountsSettings { version: 1; accounts: Account[] }
export const EMPTY_SETTINGS: AccountsSettings = Object.freeze({ version: 1, accounts: [] }) as AccountsSettings;
export const MAX_ACCOUNTS = 48;

export const presetOf = (account: Pick<Account, 'preset'>): Preset => PRESETS.find(preset => preset.id === account.preset)!;
export const protocolOf = (account: Pick<Account, 'preset'>): Protocol => presetOf(account).protocol;
export const ollamaShapeOf = (account: Pick<Account, 'preset'>): OllamaShape | null => presetOf(account).ollama ?? null;
/** The account needs a key in the plugin's secrets (every API account, and Ollama Cloud with an ollama.com key). */
export const accountKeyed = (account: Pick<Account, 'preset'>): boolean => protocolOf(account) !== 'ollama' || ollamaShapeOf(account) === 'cloud-direct';
export const secretKeyOf = (accountId: string): string => `key.${accountId}`;

export type HarnessRefusal = 'protocol' | 'responses-api';
/** Can this agent CLI run on this account's protocol? (L22 apiRuntimeSupport, without the adapters that need an
 *  agent's own config files rewritten.) */
export function harnessSupport(harness: Harness, account: Pick<Account, 'preset' | 'responsesApi'>): { ok: true } | { ok: false; reason: HarnessRefusal } {
  const protocols: Record<Harness, readonly Protocol[]> = {
    claude: ['anthropic', 'ollama'],
    codex: ['openai', 'ollama'],
    opencode: ['anthropic', 'openai', 'ollama'],
    qwen: ['openai', 'ollama'],
    kimi: ['openai', 'ollama']
  };
  const protocol = protocolOf(account);
  if (!protocols[harness].includes(protocol)) return { ok: false, reason: 'protocol' };
  if (harness === 'codex' && protocol === 'openai' && account.responsesApi !== true) return { ok: false, reason: 'responses-api' };
  return { ok: true };
}

export const supportedHarnesses = (account: Pick<Account, 'preset' | 'responsesApi'>): Harness[] => HARNESSES.filter(harness => harnessSupport(harness, account).ok);

/** `http://127.0.0.1:<port>` or `http://[::1]:<port>` with no path: a server on this computer. */
export function loopbackServerRoot(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 100) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && (url.pathname === '/' || url.pathname === '')
    && !url.username && !url.password && !url.search && !url.hash;
}

/** What the person typed for an Ollama server: `localhost` becomes 127.0.0.1, a missing scheme becomes http, the port
 *  defaults to 11434. */
export function normalizeOllamaServerUrl(text: string): string {
  let value = text.trim().replace(/\/+$/u, '');
  if (!/^[a-z]+:\/\//iu.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    if (url.protocol === 'http:' && !url.port && ['127.0.0.1', '[::1]'].includes(url.hostname)) url.port = '11434';
    return url.toString().replace(/\/$/u, '');
  } catch { return text.trim(); }
}

/** An API base URL: https (or http on this computer), no credentials, query or fragment; no trailing slash. */
export function apiBaseUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'The address is not a URL.'; }
  if (url.username || url.password) return 'The address must not contain a user name or password.';
  if (url.search || url.hash) return 'The address must not contain ? or #.';
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'Use https:// (plain http only for a server on this computer).';
  return null;
}

export type OllamaModelRefusal = 'cloud-on-local' | 'local-on-cloud' | 'empty';
/** The name the server receives for `model` on this shape (L22): a local account pins `name:local`, so the server itself
 *  refuses to forward it to ollama.com; a cloud name on a local account is refused, never sent. */
export function ollamaWireModel(shape: OllamaShape, model: string): { ok: true; model: string } | { ok: false; reason: OllamaModelRefusal } {
  const ref = parseOllamaModelRef(model);
  if (!ref.base.trim()) return { ok: false, reason: 'empty' };
  if (shape === 'local') return ref.source === 'cloud' ? { ok: false, reason: 'cloud-on-local' } : { ok: true, model: `${ref.base}:local` };
  if (ref.source === 'local') return { ok: false, reason: 'local-on-cloud' };
  if (shape === 'cloud-local') return ref.source === 'cloud' ? { ok: true, model: model.trim() } : { ok: false, reason: 'local-on-cloud' };
  // Direct ollama.com takes the hosted id without the suffix.
  return { ok: true, model: ref.base };
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const plainText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** One account as saved; throws a person-readable sentence. */
export function validateAccount(value: unknown): Account {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An account must be an object.');
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find(key => !['id', 'label', 'preset', 'baseUrl', 'model', 'responsesApi', 'agents', 'brokerable'].includes(key));
  if (unknown) throw new Error(`Unknown account field ${unknown.slice(0, 40)}.`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) throw new Error('Account id must be 1–40 lowercase letters, digits or dashes.');
  if (!plainText(raw.label, 80)) throw new Error('Give the account a name (at most 80 characters).');
  const preset = PRESETS.find(entry => entry.id === raw.preset);
  if (!preset) throw new Error('Choose a provider for the account.');
  if (typeof raw.baseUrl !== 'string') throw new Error('The account needs an address.');
  let baseUrl = raw.baseUrl.trim().replace(/\/+$/u, '');
  if (preset.ollama === 'local' || preset.ollama === 'cloud-local') {
    baseUrl = normalizeOllamaServerUrl(baseUrl);
    if (!loopbackServerRoot(baseUrl)) throw new Error('An Ollama account on this computer needs a loopback address such as http://127.0.0.1:11434.');
  } else if (preset.ollama === 'cloud-direct') {
    if (baseUrl !== OLLAMA_CLOUD_URL) throw new Error(`Ollama Cloud with a key is ${OLLAMA_CLOUD_URL}.`);
  } else {
    const problem = apiBaseUrlProblem(baseUrl);
    if (problem) throw new Error(problem);
  }
  if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error('Name the model the account runs.');
  const model = raw.model.trim();
  if (preset.ollama) {
    if (!validOllamaModelName(model)) throw new Error('The Ollama model name is invalid.');
    const wire = ollamaWireModel(preset.ollama, model);
    if (!wire.ok) {
      throw new Error(wire.reason === 'cloud-on-local' ? `Model ${model} runs on Ollama Cloud; use an Ollama Cloud account for it.`
        : wire.reason === 'local-on-cloud' ? `Model ${model} is not an Ollama Cloud name; name it with -cloud or :cloud (for example gpt-oss:120b-cloud).`
          : 'Name the model the account runs.');
    }
  } else if (!plainText(model, 200) || /\s/u.test(model) || model.startsWith('-')) throw new Error('The model name is invalid.');
  if (raw.responsesApi !== undefined && typeof raw.responsesApi !== 'boolean') throw new Error('responsesApi must be true or false.');
  const responsesApi = preset.protocol === 'openai' && raw.responsesApi === true;
  if (!Array.isArray(raw.agents) || raw.agents.some(agent => !HARNESSES.includes(agent as Harness))) throw new Error('Choose which agents may use the account.');
  const agents = HARNESSES.filter(harness => (raw.agents as unknown[]).includes(harness));
  const candidate = { preset: preset.id, responsesApi };
  const refused = agents.find(agent => !harnessSupport(agent, candidate).ok);
  if (refused) {
    throw new Error(harnessSupport(refused, candidate).ok === false && (harnessSupport(refused, candidate) as { reason: HarnessRefusal }).reason === 'responses-api'
      ? 'Codex needs an endpoint with the OpenAI Responses API; tick it only if the provider documents /responses.'
      : `${HARNESS_LABELS[refused]} cannot run on ${preset.label}.`);
  }
  if (!agents.length) throw new Error('Choose at least one agent for the account.');
  if (raw.brokerable !== undefined && typeof raw.brokerable !== 'boolean') throw new Error('brokerable must be true or false.');
  const brokerable = raw.brokerable === true;
  if (brokerable && !brokerableShape({ preset: preset.id, baseUrl })) {
    throw new Error(decisionsOnlyAccount({ preset: preset.id, baseUrl }) ? `${DECISIONS_ONLY_REASON}.` : 'Only an API account with a key can be used by other extensions.');
  }
  return { id: raw.id, label: raw.label.trim(), preset: preset.id, baseUrl, model, ...(responsesApi ? { responsesApi } : {}), agents, ...(brokerable ? { brokerable } : {}) };
}

/** Accounts that may be offered for brokered requests at all: an API (not Ollama) account with a key, not OpenRouter. */
export function brokerableShape(account: Pick<Account, 'preset' | 'baseUrl'>): boolean {
  const protocol = protocolOf(account);
  return (protocol === 'openai' || protocol === 'anthropic') && !decisionsOnlyAccount(account);
}

/** What CanvasTTY's `canvastty.broker.offer` lists for one account (the host adds the key; the caller never sees it). */
export interface BrokerOffer {
  id: string;
  label: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  paths: string[];
  models: string[];
  secretKey: string;
  auth: 'bearer';
  flatRate: boolean;
}

/**
 * The offer for one account the person marked. Anthropic-compatible endpoints take `<base>/v1/messages` (as Claude
 * Code calls them, with the key as a Bearer token); OpenAI-compatible ones `<base>/chat/completions`, `/models` and,
 * when the endpoint has it, `/responses`.
 */
export function brokerOfferOf(account: Account, flatRate: boolean): BrokerOffer | null {
  if (account.brokerable !== true || !brokerableShape(account)) return null;
  const protocol = protocolOf(account) as 'openai' | 'anthropic';
  return {
    id: account.id,
    label: account.label,
    protocol,
    baseUrl: protocol === 'anthropic' ? `${account.baseUrl}/v1` : account.baseUrl,
    paths: protocol === 'anthropic' ? ['/messages'] : ['/chat/completions', ...(account.responsesApi ? ['/responses'] : []), '/models'],
    models: [account.model],
    secretKey: secretKeyOf(account.id),
    auth: 'bearer',
    flatRate
  };
}

/** The saved settings; anything invalid is refused as a whole (the page shows why). */
export function validateSettings(value: unknown): AccountsSettings {
  if (value === null || value === undefined) return { version: 1, accounts: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object.');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.accounts) || raw.accounts.length > MAX_ACCOUNTS) throw new Error(`At most ${MAX_ACCOUNTS} accounts.`);
  const accounts = raw.accounts.map(validateAccount);
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error(`Two accounts are named ${account.id}.`);
    ids.add(account.id);
  }
  return { version: 1, accounts };
}

/** Settings as stored earlier: invalid entries are dropped instead of losing every account. */
export function loadSettings(value: unknown): AccountsSettings {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { accounts?: unknown }).accounts)) return { version: 1, accounts: [] };
  const accounts: Account[] = [];
  for (const entry of (value as { accounts: unknown[] }).accounts.slice(0, MAX_ACCOUNTS)) {
    try {
      const account = validateAccount(entry);
      if (!accounts.some(existing => existing.id === account.id)) accounts.push(account);
    } catch { /* dropped */ }
  }
  return { version: 1, accounts };
}

/** A fresh id from the label: `glm-5`, `glm-5-2`, … */
export function newAccountId(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32) || 'account';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

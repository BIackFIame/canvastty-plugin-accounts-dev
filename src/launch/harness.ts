/**
 * L22 recipes as CanvasTTY launch contributions: one agent CLI (harness) on one model behind an account. Claude Code on
 * Z.AI GLM or a local Ollama model, Codex on Ollama or an OpenAI Responses endpoint, OpenCode, Qwen Code and Kimi on
 * any OpenAI-compatible API or Ollama. Pure: the service reads nothing here, runs the Ollama preflight first and owns
 * the account's agent home.
 *
 * Nothing here writes the agent's own configuration (~/.claude, ~/.codex, ~/.qwen, ~/.kimi, ~/.ollama): every setting is
 * a per-run environment variable, flag or file in the run's `{launchFiles}` folder (which CanvasTTY creates and removes),
 * and Claude Code and Codex run in the account's own home under the plugin's data folder, so the person's own sign-in
 * is never read or sent to another base URL.
 *
 * Keys: never in argv and never through this code. The key stays in the plugin's secrets and CanvasTTY puts it into
 * the one variable the CLI reads it from (`secretEnv`): Claude's ANTHROPIC_AUTH_TOKEN, Qwen's OPENAI_API_KEY, or
 * CTTY_MODEL_API_KEY named by Codex's env_key and OpenCode's {env:…}. Kimi with a key is the exception: its config file
 * carries the key, so the service reads it (the value is masked for agents) and hands it over as a private run file.
 *
 * Recipes follow `ollama launch` v0.34.4 without its persistent writes.
 */
import type { Harness, OllamaShape, Protocol } from '../shared/accounts.ts';

export const MODEL_KEY_ENV = 'CTTY_MODEL_API_KEY';
/** The token a keyless Ollama server accepts (any value works; Ollama's own recipes send this one). */
export const OLLAMA_PLACEHOLDER_KEY = 'ollama';
/** Replaced by CanvasTTY with this run's folder of `files`. */
export const LAUNCH_FILES = '{launchFiles}';
/**
 * CanvasTTY refuses an OpenCode or Kimi configuration with a key like these anywhere in it (they decide approvals,
 * which only the person's profile does; LaunchPipeline PERMISSION_CONFIG_KEY). The configs built here set none; the
 * one key that comes from the account is OpenCode's model name, so such a name is refused here with a clear reason.
 */
export const APPROVAL_CONFIG_KEY = /permission|approv|yolo|sandbox|dangerous|bypass|auto_?accept|trust/i;
/** OpenCode 1.18.33's own agents (`opencode agent list`): a global config may give any of them a model of its own. */
export const OPENCODE_NATIVE_AGENTS = ['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction'] as const;
const CODEX_FALLBACK_CONTEXT = 128_000;
const KIMI_FALLBACK_CONTEXT = 32_768;

export interface HarnessInput {
  harness: Harness;
  protocol: Protocol;
  /** Set for protocol "ollama". */
  ollamaShape?: OllamaShape;
  /** The account's base URL (for Ollama the server root, without /v1). */
  baseUrl: string;
  /** The name the endpoint receives (for local Ollama already `name:local`). */
  model: string;
  /** A coding plan's smaller model (Claude Code's Haiku slot; OpenCode's titles and summaries). */
  smallModel?: string;
  /** A coding plan's other models (its list): OpenCode lists them too, so the person can switch with /models. */
  models?: readonly string[];
  /** The plugin secret holding the key; undefined for a keyless Ollama server. */
  secretKey?: string;
  /** Kimi with a key only: the value itself (its config file is the only place Kimi reads a key from here). */
  keyValue?: string;
  /** Provider id inside the CLI's config namespace (`canvastty_<hash>`). */
  providerId: string;
  /** The account's own home for Claude Code (CLAUDE_CONFIG_DIR) or Codex (CODEX_HOME). */
  home?: string;
  /** Context the model runs with, when known (Ollama preflight). */
  contextWindow?: number | null;
  /** The Ollama server has cloud features on: the agent's web search is switched off (Ollama would run it on ollama.com). */
  disableWebSearch?: boolean;
  /** Codex: folders the person trusted for this launch, stated for this run only. */
  trustedFolders?: readonly string[];
}

export interface Contribution {
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  args: string[];
  files: Array<{ relPath: string; content: string }>;
  /** CanvasTTY runs its "auto" profile as accept-edits: the agent's own auto reviewer would be this model. */
  thirdPartyModel?: boolean;
}

/** TOML basic string (Codex `-c key=value` parses the value as TOML): JSON escapes are valid TOML escapes. */
const toml = (value: string): string => JSON.stringify(value);
/** TOML literal string for a path that contains `{launchFiles}` (expanded after quoting; no escapes to break). */
const tomlPath = (value: string): string => `'${value}'`;

function openAiBase(input: HarnessInput): string {
  return input.protocol === 'ollama' ? `${input.baseUrl.replace(/\/+$/u, '')}/v1` : input.baseUrl;
}

/**
 * L28: an Anthropic-compatible account keeps the base Claude Code uses (it appends /v1/messages). OpenCode's
 * @ai-sdk/anthropic appends only /messages, so it gets /v1 added.
 */
export function openCodeAnthropicBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, '');
  return /\/v1$/u.test(base) ? base : `${base}/v1`;
}

export function buildHarnessLaunch(input: HarnessInput): Contribution {
  if (input.protocol === 'ollama' && !input.ollamaShape) throw new Error('An Ollama launch needs a checked Ollama account.');
  const keyless = input.secretKey === undefined;
  if (keyless && !(input.protocol === 'ollama' && input.ollamaShape !== 'cloud-direct')) throw new Error('This account needs a key; save one in the Accounts settings.');
  const context = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : null;
  switch (input.harness) {
    case 'claude': return claudePlan(input, context);
    case 'codex': return codexPlan(input, context);
    case 'opencode': return openCodePlan(input, context);
    case 'qwen': return qwenPlan(input);
    case 'kimi': return kimiPlan(input, context);
  }
}

/**
 * Claude Code (the `ollama launch claude` recipe, which writes no files either). The Anthropic SDK appends
 * /v1/messages to ANTHROPIC_BASE_URL, so Ollama gets its server root. ANTHROPIC_API_KEY is set and empty so no inherited
 * key wins; the account's token goes in ANTHROPIC_AUTH_TOKEN (sent as Bearer, which ollama.com requires). The base
 * URL is repeated in `--settings` env (merged into CanvasTTY's own), which outranks a project's
 * .claude/settings.json, so a repository cannot point the key at another host.
 */
function claudePlan(input: HarnessInput, context: number | null): Contribution {
  if (!input.home) throw new Error('Claude Code needs the account\'s home folder.');
  const base = input.protocol === 'ollama' ? input.baseUrl.replace(/\/+$/u, '') : input.baseUrl;
  const settingsEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: input.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: input.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: input.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: input.smallModel ?? input.model,
    CLAUDE_CODE_SUBAGENT_MODEL: input.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    // Not Anthropic's API: no attribution header (it breaks prompt caching elsewhere) and the client-side auto-mode
    // classifier instead of Anthropic's server one.
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    ...(context ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(context) } : {})
  };
  const env: Record<string, string> = {
    ...settingsEnv,
    CLAUDE_CONFIG_DIR: input.home,
    // Another sign-in inherited from the person's shell must not win over the account.
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
    ...(input.secretKey === undefined ? { ANTHROPIC_AUTH_TOKEN: OLLAMA_PLACEHOLDER_KEY } : {})
  };
  return {
    env,
    secretEnv: input.secretKey === undefined ? {} : { ANTHROPIC_AUTH_TOKEN: input.secretKey },
    // Only the route in --settings (an argument is at most 1024 characters): enough that a project cannot redirect the key.
    args: ['--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: '' } }), '--model', input.model,
      ...(input.disableWebSearch ? ['--disallowedTools', 'WebSearch'] : [])],
    files: []
  };
}

/**
 * Codex 0.156 keeps folder trust as projects.<folder>.trust_level; the folders the person trusted for this launch are
 * set here for this run only. Measured with 0.156.1: the dotted override still shows "Trust this folder?", the inline
 * table does not, and it keeps the folders config.toml already trusts.
 */
export function codexTrustArguments(folders: readonly string[]): string[] {
  if (!folders.length) return [];
  return ['-c', `projects={${[...new Set(folders)].map(folder => `${toml(folder)}={trust_level=${toml('trusted')}}`).join(',')}}`];
}

/**
 * Codex (`ollama launch codex` without ~/.codex/ollama-launch.config.toml, ~/.codex/model.json or `--profile`): a
 * provider defined only by `-c` overrides, the Responses wire API (Codex 0.156 removed chat), a one-model catalog in
 * the run's folder for the context window, and the account's own CODEX_HOME. A keyed account names the key's variable
 * in env_key; a keyless Ollama server gets no Authorization at all.
 */
function codexPlan(input: HarnessInput, context: number | null): Contribution {
  if (!input.home) throw new Error('Codex needs the account\'s home folder.');
  const id = input.providerId;
  const local = input.protocol === 'ollama' && input.ollamaShape === 'local';
  const catalog = { models: [{
    slug: input.model, display_name: input.model, context_window: context ?? CODEX_FALLBACK_CONTEXT, shell_type: 'default', visibility: 'list',
    supported_in_api: true, priority: 0, truncation_policy: { mode: local ? 'bytes' : 'tokens', limit: 10_000 }, input_modalities: ['text'],
    base_instructions: '', support_verbosity: true, default_verbosity: 'low', supports_parallel_tool_calls: false, supports_reasoning_summaries: false,
    supported_reasoning_levels: [], default_reasoning_level: null, experimental_supported_tools: []
  }] };
  const baseUrl = input.protocol === 'ollama' ? `${openAiBase(input)}/` : input.baseUrl;
  const overrides = [
    `model_provider=${toml(id)}`,
    `model_providers.${id}.name=${toml('CanvasTTY')}`,
    `model_providers.${id}.base_url=${toml(baseUrl)}`,
    `model_providers.${id}.wire_api=${toml('responses')}`,
    ...(input.secretKey !== undefined ? [`model_providers.${id}.env_key=${toml(MODEL_KEY_ENV)}`] : []),
    `model_catalog_json=${tomlPath(`${LAUNCH_FILES}/codex-model.json`)}`,
    ...(input.disableWebSearch ? [`web_search=${toml('disabled')}`] : [])
  ];
  return {
    // Codex reads both as environment auth ahead of the home's own login.
    env: { CODEX_HOME: input.home, CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' },
    secretEnv: input.secretKey !== undefined ? { [MODEL_KEY_ENV]: input.secretKey } : {},
    args: [...overrides.flatMap(value => ['-c', value]), ...codexTrustArguments(input.trustedFolders ?? []), '--model', input.model],
    files: [{ relPath: 'codex-model.json', content: JSON.stringify(catalog) }]
  };
}

/**
 * OpenCode: a provider in a private config file (OPENCODE_CONFIG; CanvasTTY itself owns OPENCODE_CONFIG_CONTENT), the
 * openai-compatible SDK for OpenAI-style APIs and Ollama (<server>/v1), the anthropic SDK with /v1 for Anthropic-style
 * APIs (L28). The key is `{env:CTTY_MODEL_API_KEY}`, substituted by OpenCode as raw text (see apiKeyHygiene).
 *
 * The run sees only the account's provider: `enabled_providers` (which outranks the person's global config, merged
 * before this file) keeps OpenCode Zen and any provider the global config names unloaded, and `small_model` sends
 * titles and summaries to the account's own model (an account has one model, so it is also the cheapest one known).
 * Each native agent's `model` (title, summary, compaction, the general and explore subagents, build, plan) is pinned
 * there too, so an `agent.<name>.model` in the global config can neither send its calls elsewhere nor make them fail.
 */
function openCodePlan(input: HarnessInput, context: number | null): Contribution {
  if (APPROVAL_CONFIG_KEY.test(input.model) || APPROVAL_CONFIG_KEY.test(input.providerId) || (input.smallModel !== undefined && APPROVAL_CONFIG_KEY.test(input.smallModel))) {
    throw new Error(`OpenCode cannot run the model ${input.model.slice(0, 60)} from an account: its name would be a key CanvasTTY reserves for approval settings.`);
  }
  const npm = input.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
  const baseURL = input.protocol === 'anthropic' ? openCodeAnthropicBase(input.baseUrl) : openAiBase(input);
  const provider = {
    npm, name: 'CanvasTTY',
    options: { baseURL, ...(input.secretKey !== undefined ? { apiKey: `{env:${MODEL_KEY_ENV}}` } : {}) },
    // The account's models first, then the rest of a plan's list (names that would be reserved keys are left out).
    models: Object.fromEntries([...new Set([input.model, ...(input.smallModel ? [input.smallModel] : []), ...(input.models ?? []).filter(name => !APPROVAL_CONFIG_KEY.test(name))])]
      .map(name => [name, { name, ...(context ? { limit: { context, output: Math.min(32_768, Math.floor(context / 4)) } } : {}) }]))
  };
  const model = `${input.providerId}/${input.model}`;
  const small = input.smallModel ? `${input.providerId}/${input.smallModel}` : model;
  const smallAgents = new Set(['title', 'summary']);
  return {
    env: { OPENCODE_CONFIG: `${LAUNCH_FILES}/opencode.json` },
    secretEnv: input.secretKey !== undefined ? { [MODEL_KEY_ENV]: input.secretKey } : {},
    args: ['--model', model],
    files: [{ relPath: 'opencode.json', content: JSON.stringify({
      $schema: 'https://opencode.ai/config.json', enabled_providers: [input.providerId], provider: { [input.providerId]: provider }, model, small_model: small,
      agent: Object.fromEntries(OPENCODE_NATIVE_AGENTS.map(name => [name, { model: smallAgents.has(name) ? small : model }]))
    }) }]
  };
}

/** Qwen Code: `--auth-type openai` with OPENAI_* (Ollama's recipe without its ~/.qwen/settings.json rewrite). */
function qwenPlan(input: HarnessInput): Contribution {
  return {
    env: { OPENAI_BASE_URL: openAiBase(input), OPENAI_MODEL: input.model, ...(input.secretKey === undefined ? { OPENAI_API_KEY: OLLAMA_PLACEHOLDER_KEY } : {}) },
    secretEnv: input.secretKey === undefined ? {} : { OPENAI_API_KEY: input.secretKey },
    args: ['--auth-type', 'openai', '--model', input.model],
    files: []
  };
}

/**
 * Kimi: an `openai_legacy` provider under the alias `canvastty`. Keyless Ollama gets `ollama launch kimi`'s inline
 * `--config`; an account with a key gets the same JSON in a private run file (`--config-file`), so the key is never in
 * argv.
 */
function kimiPlan(input: HarnessInput, context: number | null): Contribution {
  if (input.secretKey !== undefined && !input.keyValue) throw new Error('Kimi needs the account key to write its private config.');
  const config = {
    default_model: 'canvastty',
    providers: { canvastty: { type: 'openai_legacy', base_url: openAiBase(input), api_key: input.keyValue ?? OLLAMA_PLACEHOLDER_KEY } },
    models: { canvastty: { provider: 'canvastty', model: input.model, max_context_size: context ?? KIMI_FALLBACK_CONTEXT } }
  };
  if (input.secretKey === undefined) return { env: {}, secretEnv: {}, args: ['--config', JSON.stringify(config)], files: [] };
  return { env: {}, secretEnv: {}, args: ['--config-file', `${LAUNCH_FILES}/kimi-config.json`], files: [{ relPath: 'kimi-config.json', content: JSON.stringify(config) }] };
}

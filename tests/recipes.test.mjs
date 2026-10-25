// L22 recipes (pure) and the account model: what each agent CLI receives for one account, and which accounts are valid.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APPROVAL_CONFIG_KEY, buildHarnessLaunch, codexTrustArguments, MODEL_KEY_ENV, OPENCODE_NATIVE_AGENTS, openCodeAnthropicBase } from '../src/launch/harness.ts';
import { effortArguments } from '../src/launch/effort.ts';
import {
  accountKeyed, decisionsOnlyAccount, harnessSupport, isDecisionOnlyHost, loadSettings, newAccountId, normalizeOllamaServerUrl, ollamaWireModel, supportedHarnesses, validateAccount, validateSettings
} from '../src/shared/accounts.ts';
import { apiKeyProblem, envSubstitutionProblem } from '../src/shared/apiKeyHygiene.ts';

const HOME = '/data/homes/claude-glm';
const SECRET = 'key.glm';
const base = { providerId: 'canvastty_abc', home: HOME };
const flat = (plan) => JSON.stringify(plan);

test('Claude on local Ollama: server root, placeholder token, every model tier, own home, route repeated in --settings', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536, disableWebSearch: true });
  assert.equal(plan.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.equal(plan.env.ANTHROPIC_API_KEY, '', 'set and empty so an inherited key cannot win');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(plan.env[name], 'qwen3.5:9b:local', name);
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) assert.equal(plan.env[name], '', name);
  assert.equal(plan.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '65536');
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, HOME);
  assert.deepEqual(plan.secretEnv, {});
  assert.deepEqual(JSON.parse(plan.args[1]), { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_API_KEY: '' } });
  assert.deepEqual(plan.args.slice(2), ['--model', 'qwen3.5:9b:local', '--disallowedTools', 'WebSearch']);
  assert.ok(Object.keys(plan.env).length <= 32, 'CanvasTTY takes at most 32 variables');
  assert.ok(plan.args.every(arg => arg.length <= 1024), 'and arguments of at most 1024 characters');
});

test('Claude on an Anthropic-compatible API (Z.AI): the key only as a secret variable, never in argv or files', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3', secretKey: SECRET });
  assert.deepEqual(plan.secretEnv, { ANTHROPIC_AUTH_TOKEN: SECRET });
  assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(plan.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(JSON.parse(plan.args[1]).env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'a project\'s settings cannot redirect the key');
  assert.ok(!plan.args.includes('--disallowedTools'));
  assert.deepEqual(plan.files, []);
});

test('Codex on local Ollama: -c provider with the Responses wire API, a private catalog, the account home, no auth', () => {
  const plan = buildHarnessLaunch({ ...base, home: '/data/homes/codex-q', harness: 'codex', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 32768, disableWebSearch: true, trustedFolders: ['/work/app'] });
  assert.deepEqual(plan.args, [
    '-c', 'model_provider="canvastty_abc"',
    '-c', 'model_providers.canvastty_abc.name="CanvasTTY"',
    '-c', 'model_providers.canvastty_abc.base_url="http://127.0.0.1:11434/v1/"',
    '-c', 'model_providers.canvastty_abc.wire_api="responses"',
    '-c', "model_catalog_json='{launchFiles}/codex-model.json'",
    '-c', 'web_search="disabled"',
    '-c', 'projects={"/work/app"={trust_level="trusted"}}',
    '--model', 'qwen3.5:9b:local'
  ]);
  assert.deepEqual(plan.env, { CODEX_HOME: '/data/homes/codex-q', CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' });
  assert.deepEqual(plan.secretEnv, {});
  const catalog = JSON.parse(plan.files[0].content);
  assert.equal(plan.files[0].relPath, 'codex-model.json');
  assert.equal(catalog.models[0].slug, 'qwen3.5:9b:local');
  assert.equal(catalog.models[0].context_window, 32768);
  assert.equal(catalog.models[0].truncation_policy.mode, 'bytes');
  assert.ok(!plan.args.some(arg => /--oss|--profile/u.test(arg)), 'never --oss (downloads) or --profile (a file in ~/.codex)');
});

test('Codex on a Responses endpoint with a key: env_key names the variable CanvasTTY fills from the secret', () => {
  const plan = buildHarnessLaunch({ ...base, harness: 'codex', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3', secretKey: SECRET });
  assert.ok(plan.args.includes(`model_providers.canvastty_abc.env_key="${MODEL_KEY_ENV}"`));
  assert.ok(plan.args.includes('model_providers.canvastty_abc.base_url="https://openrouter.ai/api/v1"'));
  assert.deepEqual(plan.secretEnv, { [MODEL_KEY_ENV]: SECRET });
  assert.equal(JSON.parse(plan.files[0].content).models[0].context_window, 128000, 'Codex\'s own fallback when nothing is known');
  assert.deepEqual(codexTrustArguments([]), []);
});

test('OpenCode: a private OPENCODE_CONFIG (CanvasTTY owns OPENCODE_CONFIG_CONTENT); Anthropic APIs get /v1 (L28)', () => {
  const anthropic = buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3', secretKey: SECRET });
  assert.deepEqual(anthropic.env, { OPENCODE_CONFIG: '{launchFiles}/opencode.json' });
  assert.deepEqual(anthropic.secretEnv, { [MODEL_KEY_ENV]: SECRET });
  const config = JSON.parse(anthropic.files[0].content);
  assert.equal(config.provider.canvastty_abc.npm, '@ai-sdk/anthropic');
  assert.equal(config.provider.canvastty_abc.options.baseURL, 'https://api.minimax.io/anthropic/v1');
  assert.equal(config.provider.canvastty_abc.options.apiKey, `{env:${MODEL_KEY_ENV}}`);
  assert.equal(config.model, 'canvastty_abc/MiniMax-M3');
  assert.deepEqual(anthropic.args, ['--model', 'canvastty_abc/MiniMax-M3']);
  assert.equal(openCodeAnthropicBase('https://x.test/v1/'), 'https://x.test/v1');
  const ollama = buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536 });
  const local = JSON.parse(ollama.files[0].content).provider.canvastty_abc;
  assert.equal(local.npm, '@ai-sdk/openai-compatible');
  assert.equal(local.options.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(local.options.apiKey, undefined);
  assert.equal(local.models['qwen3.5:9b:local'].limit.context, 65536);
  assert.deepEqual(ollama.secretEnv, {});
});

test('OpenCode sees only the account\'s provider: enabled_providers and small_model on the account\'s own model', () => {
  for (const shape of [
    { protocol: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3', secretKey: SECRET },
    { protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', secretKey: SECRET },
    { protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local' }
  ]) {
    const config = JSON.parse(buildHarnessLaunch({ ...base, harness: 'opencode', ...shape }).files[0].content);
    assert.deepEqual(config.enabled_providers, ['canvastty_abc'], shape.protocol);
    assert.deepEqual(Object.keys(config.provider), ['canvastty_abc']);
    assert.equal(config.model, `canvastty_abc/${shape.model}`);
    assert.equal(config.small_model, config.model, 'titles and summaries on the account\'s own (only) model');
    assert.ok(config.provider.canvastty_abc.models[shape.model], 'small_model names a model the provider defines');
    assert.deepEqual(Object.keys(config.agent), ['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction']);
    for (const name of OPENCODE_NATIVE_AGENTS) assert.deepEqual(config.agent[name], { model: config.model }, name);
  }
});

/** OpenCode's config merge (global, then OPENCODE_CONFIG): objects merge, later scalars and arrays replace. Checked
 *  against `opencode debug config` 1.18.33: a global enabled_providers ["opencode","anthropic"] became ["canvastty_…"]. */
const mergeConfig = (target, source) => {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
      ? mergeConfig(out[key], value) : value;
  }
  return out;
};

test('a global OpenCode config naming other providers (OpenCode Zen, a collector) does not reach the run', () => {
  const global = {
    model: 'opencode/gpt-5-nano', small_model: 'opencode/gpt-5-nano', enabled_providers: ['opencode', 'anthropic'],
    agent: { title: { model: 'opencode/gpt-5-nano', temperature: 0.2 }, summary: { model: 'anthropic/claude-haiku-4-5' }, compaction: { model: 'collector/m' }, general: { model: 'collector/m' } },
    provider: { collector: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://collector.test/v1' }, models: { m: {} } } }
  };
  const ours = JSON.parse(buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', secretKey: SECRET }).files[0].content);
  const effective = mergeConfig(global, ours);
  assert.deepEqual(effective.enabled_providers, ['canvastty_abc'], 'only the account\'s provider is loaded');
  assert.equal(effective.model, 'canvastty_abc/glm-5.3');
  assert.equal(effective.small_model, 'canvastty_abc/glm-5.3', 'title and summary calls stay on the account');
  // The global provider definitions remain in the merged file but are never loaded.
  for (const id of ['opencode', 'anthropic', 'collector']) assert.ok(!effective.enabled_providers.includes(id), id);
  for (const name of OPENCODE_NATIVE_AGENTS) assert.equal(effective.agent[name].model, 'canvastty_abc/glm-5.3', `agent ${name}`);
  assert.equal(effective.agent.title.temperature, 0.2, 'only the model is pinned; the person\'s other agent settings stay');
  // Without the pins (the earlier config) the global small model was OpenCode Zen's.
  const { enabled_providers: _e, small_model: _s, ...unpinned } = ours;
  assert.equal(mergeConfig(global, unpinned).small_model, 'opencode/gpt-5-nano');
});

// Real OpenCode, only when OPENCODE_BIN names a binary: `opencode models` under a fake HOME whose global config names
// OpenCode Zen and a collector lists only the account's model. Offline (models fetch off), nothing is sent.
test('real OpenCode resolves only the account\'s provider (OPENCODE_BIN)', { skip: !process.env.OPENCODE_BIN && 'set OPENCODE_BIN to run' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'canvastty-accounts-oc-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const dir of ['.config/opencode', 'run', 'project', 'tmp']) await mkdir(join(home, dir), { recursive: true });
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({
    small_model: 'opencode/gpt-5-nano', enabled_providers: ['opencode', 'collector'],
    agent: { title: { model: 'opencode/gpt-5-nano' }, summary: { model: 'collector/m' }, compaction: { model: 'collector/m' }, explore: { model: 'opencode/gpt-5-nano' } },
    provider: { collector: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://collector.test/v1' }, models: { m: { name: 'm' } } } }
  }));
  const plan = buildHarnessLaunch({ ...base, harness: 'opencode', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', secretKey: SECRET });
  await writeFile(join(home, 'run/opencode.json'), plan.files[0].content);
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'), TMPDIR: join(home, 'tmp'), OPENCODE_CONFIG: join(home, 'run/opencode.json'),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' };
  // Output goes to a file: OpenCode can exit before a pipe is drained, cutting the last lines.
  let runs = 0;
  const run = async (args) => {
    const out = join(home, 'tmp', `out-${runs++}.txt`);
    const handle = await open(out, 'w');
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.OPENCODE_BIN, args, { cwd: join(home, 'project'), env, stdio: ['ignore', handle.fd, 'ignore'] });
        const timer = setTimeout(() => child.kill(), 40_000);
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`opencode ${args.join(' ')} exited ${code}`)); });
      });
    } finally { await handle.close(); }
    return readFile(out, 'utf8');
  };
  assert.deepEqual((await run(['models', '--pure'])).trim().split('\n'), ['canvastty_abc/glm-5.3']);
  assert.match(await run(['debug', 'config', '--pure']), /"small_model": "canvastty_abc\/glm-5\.3"/);
  // Every agent this OpenCode has is one the config pins (a new native agent would show up here).
  const agents = (await run(['agent', 'list', '--pure'])).split('\n').map(line => /^(\S+) \((?:primary|subagent|all)\)$/u.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual([...agents].sort(), [...OPENCODE_NATIVE_AGENTS].sort());
  for (const name of OPENCODE_NATIVE_AGENTS) {
    assert.deepEqual(JSON.parse(await run(['debug', 'agent', name, '--pure'])).model, { providerID: 'canvastty_abc', modelID: 'glm-5.3' }, name);
  }
});

test('OpenRouter is for Jev\'s decisions only: the host predicate and the accounts it marks', () => {
  for (const url of ['https://openrouter.ai/api/v1', 'https://OpenRouter.AI./api', 'https://x.openrouter.ai/v1', 'https://user@openrouter.ai/api', 'not a url']) {
    assert.equal(isDecisionOnlyHost(url), true, url);
  }
  for (const url of ['https://api.z.ai/api/anthropic', 'https://openrouter.ai.evil.test/v1', 'https://notopenrouter.ai/v1', 'https://openrouter.ai@evil.test/v1', 'http://127.0.0.1:11434']) {
    assert.equal(isDecisionOnlyHost(url), false, url);
  }
  assert.equal(decisionsOnlyAccount({ preset: 'openrouter-anthropic', baseUrl: 'https://openrouter.ai/api' }), true);
  assert.equal(decisionsOnlyAccount({ preset: 'custom-openai', baseUrl: 'https://eu.openrouter.ai/api/v1' }), true, 'a custom address there too');
  assert.equal(decisionsOnlyAccount({ preset: 'zai-openai', baseUrl: 'https://api.z.ai/api/paas/v4' }), false);
});

test('Qwen Code and Kimi: OPENAI_* or an openai_legacy alias; Kimi\'s key only in a private run file', () => {
  const qwen = buildHarnessLaunch({ ...base, harness: 'qwen', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local' });
  assert.deepEqual(qwen.args, ['--auth-type', 'openai', '--model', 'qwen3.5:9b:local']);
  assert.deepEqual(qwen.env, { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'qwen3.5:9b:local', OPENAI_API_KEY: 'ollama' });
  const keyedQwen = buildHarnessLaunch({ ...base, harness: 'qwen', protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', secretKey: SECRET });
  assert.deepEqual(keyedQwen.secretEnv, { OPENAI_API_KEY: SECRET });
  assert.equal(keyedQwen.env.OPENAI_API_KEY, undefined);
  const kimi = buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536 });
  assert.equal(kimi.args[0], '--config');
  const config = JSON.parse(kimi.args[1]);
  assert.deepEqual(config.providers.canvastty, { type: 'openai_legacy', base_url: 'http://127.0.0.1:11434/v1', api_key: 'ollama' });
  assert.equal(config.models.canvastty.max_context_size, 65536);
  const key = ['fixture', 'kimi', 'key', '0123456789abcdef'].join('-');
  const keyedKimi = buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2', secretKey: SECRET, keyValue: key });
  assert.deepEqual(keyedKimi.args, ['--config-file', '{launchFiles}/kimi-config.json']);
  assert.ok(!keyedKimi.args.join(' ').includes(key));
  assert.equal(JSON.parse(keyedKimi.files[0].content).providers.canvastty.api_key, key);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2', secretKey: SECRET }), /Kimi needs the account key/);
});

/** A key anywhere in a config object that CanvasTTY's launch check (LaunchPipeline permissionConfigProblem) refuses. */
function approvalKey(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (APPROVAL_CONFIG_KEY.test(key)) return key;
    const nested = approvalKey(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

test('no generated OpenCode, Kimi or Codex configuration carries an approval, permission or sandbox key', () => {
  // The same pattern as CanvasTTY's PERMISSION_CONFIG_KEY (core LaunchPipeline.ts).
  assert.equal(String(APPROVAL_CONFIG_KEY), String(/permission|approv|yolo|sandbox|dangerous|bypass|auto_?accept|trust/i));
  const shapes = [
    { protocol: 'ollama', ollamaShape: 'local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b:local', contextWindow: 65536 },
    { protocol: 'ollama', ollamaShape: 'cloud-direct', baseUrl: 'https://ollama.com', model: 'glm-5.3', secretKey: SECRET, keyValue: 'fixture-key' },
    { protocol: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', secretKey: SECRET, keyValue: 'fixture-key' },
    { protocol: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M3', secretKey: SECRET, keyValue: 'fixture-key' }
  ];
  for (const shape of shapes) {
    const opencode = buildHarnessLaunch({ ...base, harness: 'opencode', ...shape });
    assert.deepEqual(Object.keys(opencode.env), ['OPENCODE_CONFIG'], 'no OPENCODE_PERMISSION or OPENCODE_CONFIG_DIR');
    assert.equal(approvalKey(JSON.parse(opencode.files[0].content)), null, `opencode ${shape.protocol}`);
    if (shape.protocol !== 'anthropic') {
      const kimi = buildHarnessLaunch({ ...base, harness: 'kimi', ...shape });
      const inline = kimi.args[0] === '--config' ? kimi.args[1] : kimi.files[0].content;
      assert.equal(approvalKey(JSON.parse(inline)), null, `kimi ${shape.protocol}`);
    }
    if (shape.protocol !== 'anthropic') {
      const codex = buildHarnessLaunch({ ...base, harness: 'codex', ...shape, protocol: shape.protocol === 'openai' ? 'openai' : shape.protocol });
      const keys = codex.args.flatMap((arg, index) => (codex.args[index - 1] === '-c' ? [arg.split('=', 1)[0]] : []));
      assert.ok(keys.length > 0 && keys.every((key) => !APPROVAL_CONFIG_KEY.test(key)), `codex ${keys}`);
    }
  }
  // Folder trust reaches Codex only when the person trusted the folder for this launch (a subagent never does).
  assert.ok(!buildHarnessLaunch({ ...base, harness: 'codex', ...shapes[0] }).args.some((arg) => arg.startsWith('projects=')));
  // The one key that comes from the account (OpenCode's model name) is refused before CanvasTTY would refuse the file.
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'opencode', ...shapes[0], model: 'sandbox-coder:7b' }), /reserves for approval settings/);
});

test('a keyed account never builds without its key; Ollama needs its checked shape', () => {
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3' }), /needs a key/);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', ollamaShape: 'cloud-direct', baseUrl: 'https://ollama.com', model: 'glm-5.3' }), /needs a key/);
  assert.throws(() => buildHarnessLaunch({ ...base, harness: 'claude', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'x:local' }), /checked Ollama account/);
});

test('reasoning effort uses each CLI\'s verified flag and refuses levels an agent does not have', () => {
  assert.deepEqual(effortArguments('codex', 'high'), ['-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(effortArguments('claude', 'max'), ['--effort', 'max']);
  assert.deepEqual(effortArguments('grok', 'xhigh'), ['--reasoning-effort', 'xhigh']);
  assert.deepEqual(effortArguments('opencode', 'default'), []);
  assert.throws(() => effortArguments('claude', 'minimal'), /no reasoning effort "minimal"/);
  assert.throws(() => effortArguments('qwen', 'high'), /through the model/);
  assert.throws(() => effortArguments('codex', 'turbo'), /Unknown reasoning effort/);
});

const account = (patch = {}) => ({ id: 'q', label: 'Qwen local', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude', 'codex'], ...patch });

test('accounts: presets decide the protocol, the agents that can use it and whether a key is needed', () => {
  assert.deepEqual(validateAccount(account()), account());
  assert.equal(validateAccount(account({ baseUrl: 'localhost' })).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaServerUrl('127.0.0.1:11500/'), 'http://127.0.0.1:11500');
  assert.throws(() => validateAccount(account({ baseUrl: 'http://10.0.0.5:11434' })), /loopback/);
  assert.throws(() => validateAccount(account({ model: 'gpt-oss:120b-cloud' })), /Ollama Cloud/);
  assert.throws(() => validateAccount(account({ preset: 'ollama-cloud-local', model: 'qwen3.5:9b' })), /not an Ollama Cloud name/);
  assert.equal(validateAccount(account({ preset: 'ollama-cloud-local', model: 'gpt-oss:120b-cloud' })).model, 'gpt-oss:120b-cloud');
  assert.throws(() => validateAccount(account({ preset: 'ollama-cloud', baseUrl: 'https://evil.test' })), /ollama\.com/);
  const glm = validateAccount({ id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic/', model: 'glm-5.3', agents: ['claude', 'opencode'] });
  assert.equal(glm.baseUrl, 'https://api.z.ai/api/anthropic');
  assert.equal(accountKeyed(glm), true);
  assert.equal(accountKeyed(account()), false);
  assert.throws(() => validateAccount({ ...glm, agents: ['codex'] }), /Codex cannot run on Z.AI · Anthropic API/);
  assert.throws(() => validateAccount({ ...glm, baseUrl: 'http://api.z.ai/api/anthropic' }), /https/);
  assert.throws(() => validateAccount({ ...glm, baseUrl: 'https://user:pw@api.z.ai' }), /user name or password/);
  const router = { id: 'or', label: 'OR', preset: 'openrouter-openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3', agents: ['codex'] };
  assert.throws(() => validateAccount(router), /Responses API/);
  assert.deepEqual(validateAccount({ ...router, responsesApi: true }).agents, ['codex']);
  assert.deepEqual(supportedHarnesses({ preset: 'openrouter-openai' }), ['opencode', 'qwen', 'kimi']);
  assert.equal(harnessSupport('claude', { preset: 'minimax-openai' }).ok, false);
  assert.throws(() => validateAccount(account({ agents: [] })), /at least one agent/);
  assert.throws(() => validateAccount(account({ extra: 1 })), /Unknown account field/);
  assert.throws(() => validateSettings({ accounts: [account(), account()] }), /Two accounts/);
  assert.deepEqual(loadSettings({ accounts: [account(), { id: 'bad' }] }).accounts.map(entry => entry.id), ['q']);
  assert.equal(newAccountId('Claude Code · GLM 4.6', new Set(['claude-code-glm-4-6'])), 'claude-code-glm-4-6-2');
});

test('Ollama model names: a local account pins name:local; cloud names never go through a local account', () => {
  assert.deepEqual(ollamaWireModel('local', 'qwen3.5:9b'), { ok: true, model: 'qwen3.5:9b:local' });
  assert.deepEqual(ollamaWireModel('local', 'gpt-oss:120b-cloud'), { ok: false, reason: 'cloud-on-local' });
  assert.deepEqual(ollamaWireModel('cloud-local', 'gpt-oss:120b-cloud'), { ok: true, model: 'gpt-oss:120b-cloud' });
  assert.deepEqual(ollamaWireModel('cloud-direct', 'gpt-oss:120b:cloud'), { ok: true, model: 'gpt-oss:120b' });
});

test('key hygiene (L27): a pasted key with a space, quote or backslash is refused; OpenCode substitution is checked', () => {
  const good = ['sk', 'or', 'v1', 'a'.repeat(32)].join('-');
  assert.equal(apiKeyProblem(good), null);
  assert.equal(apiKeyProblem(`${good} x`), 'whitespace');
  assert.equal(apiKeyProblem(`${good}"`), 'quote');
  assert.equal(apiKeyProblem(`${good}\\`), 'backslash');
  assert.equal(envSubstitutionProblem(good), null);
  assert.equal(envSubstitutionProblem(`${good}\u0001`), 'control');
  assert.ok(!flat(buildHarnessLaunch({ ...base, harness: 'codex', protocol: 'openai', baseUrl: 'https://x.test/v1', model: 'm', secretKey: SECRET })).includes(good));
});

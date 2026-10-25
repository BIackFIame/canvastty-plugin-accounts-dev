// The installable package as CanvasTTY runs it: the manifest's file integrity, the manifest against CanvasTTY's own
// validator, and the bundled service as a child process speaking JSON-RPC lines (with the host's calls answered by the
// test, or — when CANVASTTY_REPO points at a checkout — CanvasTTY's own supervisor and launch pipeline).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'canvastty-accounts-bundle-')));
const project = join(base, 'project');
mkdirSync(project, { recursive: true });
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const KEY = ['sk', 'bundle', 'fixture', '0123456789abcdef'].join('-');

test('the manifest\'s coreFiles match the package bytes, and the service and page are single bundled files', () => {
  for (const file of manifest.coreFiles) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path}: run npm run build`);
  }
  for (const path of ['services/accounts.mjs', 'settings/accounts.js']) {
    assert.ok(manifest.coreFiles.some(file => file.path === path), path);
    assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /^import .* from ["']\.\.?\//mu, `${path} is bundled`);
  }
  assert.equal(manifest.id, 'canvastty-accounts');
  // Orchestrators pass list_routes / pick_account answers to spawn_agent: the options are declared safe to delegate.
  assert.equal(manifest.services[0].launch.delegable, true);
  // The Assistant (Jev) sees which account or pool a launch chose (peerOptions; needs a core that knows visibleTo).
  assert.deepEqual(manifest.services[0].launch.fields.find(field => field.key === 'account').visibleTo, ['canvastty-assistant']);
  assert.ok(!manifest.permissions.includes('network'), 'a service needs no surface network permission');
});

test('the manifest passes CanvasTTY\'s own validator (when CANVASTTY_REPO points at a checkout)', { skip: !process.env.CANVASTTY_REPO }, async () => {
  const { validatePluginManifest } = await import(join(process.env.CANVASTTY_REPO, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  assert.equal(checked.services[0].launch.fields[0].optionsFrom, 'service');
  assert.deepEqual(checked.services[0].tools.map(tool => tool.name), ['list_routes', 'pick_account']);
});

function startService(t, { dataDir, host = {} }) {
  // No provider is ever contacted from a test: a saved key would otherwise start a model-list read on the plan's host.
  const child = spawn(process.execPath, [join(root, 'services', 'accounts.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: base, CANVASTTY_ACCOUNTS_NO_NETWORK: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let nextId = 1;
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: child.stdout }).on('line', async line => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      try {
        const handler = host[message.method];
        if (!handler) throw new Error(`host: ${message.method} not allowed`);
        write({ id: message.id, result: (await handler(message.params)) ?? null });
      } catch (error) {
        write({ id: message.id, error: { code: -32000, message: error.message } });
      }
      return;
    }
    if (message.method) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  write({ method: 'canvastty.initialize', params: { apiVersion: 2, pluginId: manifest.id, serviceId: 'accounts', dataDir, locale: 'ru', hostVersion: 'test' } });
  return {
    notify: (method, params) => write({ method, params }),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = `t${nextId++}`;
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    })
  };
}

test('end to end over JSON-RPC: the page saves accounts, the launcher lists them, a launch is prepared, tools answer', async (t) => {
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  const storage = {};
  const secrets = { 'key.glm': KEY };
  const dataDir = join(base, 'data');
  const service = startService(t, { dataDir, host: {
    'storage.get': ({ key }) => storage[key] ?? null,
    'storage.set': ({ key, value }) => { storage[key] = value; },
    'secrets.get': ({ key }) => secrets[key] ?? null
  } });
  assert.deepEqual((await service.request('state')).settings.accounts, []);
  await service.request('save', { settings: { version: 1, accounts: [
    { id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude', 'codex'] },
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.3', agents: ['claude'] }
  ] } });
  await service.request('keyChanged', { accountId: 'glm' });
  assert.equal(storage.accounts.keyOrigins.glm, 'https://api.z.ai');
  assert.equal((await service.request('state')).models.glm.source, 'bundled', 'no model list was read (no network in tests)');
  assert.deepEqual((await service.request('canvastty.launch.options', { provider: 'codex', fields: ['account'] })).account, [{ value: 'qwen', label: 'Qwen · qwen3.5:9b' }]);
  const launch = await service.request('canvastty.launch.prepare', { sessionId: 's', provider: 'codex', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    options: { account: 'qwen', effort: 'default', trustFolder: false }, chosen: true, environment: null });
  assert.equal(launch.env.CODEX_HOME, join(dataDir, 'homes', 'codex-qwen'));
  assert.deepEqual(readdirSync(join(dataDir, 'homes')), ['codex-qwen']);
  const keyed = await service.request('canvastty.launch.prepare', { sessionId: 's', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    options: { account: 'glm', effort: 'default', trustFolder: false }, chosen: true, environment: null });
  assert.deepEqual(keyed.secretEnv, { ANTHROPIC_AUTH_TOKEN: 'key.glm' });
  assert.ok(!JSON.stringify(keyed).includes(KEY));
  const check = await service.request('check', { accountId: 'qwen' });
  assert.equal(check.models[0].name, 'qwen3.5:9b');
  const routes = await service.request('canvastty.tools.call', { tool: 'list_routes', caller: { id: 'o', role: 'orchestrator' }, input: {} });
  assert.deepEqual(routes.content.routes.map(row => `${row.provider}:${row.accountId}:${row.state}`), ['claude:qwen:ready', 'codex:qwen:ready', 'claude:glm:ready', 'opencode:glm:ready']);
});

test('through CanvasTTY\'s own supervisor and launch pipeline: the launcher list and a prepared launch (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  const checked = validatePluginManifest(manifest);
  const storage = { accounts: { settings: { version: 1, accounts: [{ id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude'] }] }, keyOrigins: {} } };
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: { storageGet: async (_plugin, key) => storage[key] ?? null, storageSet: async (_plugin, key, value) => { storage[key] = value; }, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'accounts.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'accounts', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    dataDir: join(base, 'core-data'), permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'accounts', launch: checked.services[0].launch, secrets: true }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot: join(base, 'runs')
  });
  assert.deepEqual(await pipeline.fieldOptions(checked.id, 'claude'), { account: [{ value: 'qwen', label: 'Qwen · qwen3.5:9b' }] });
  const options = pipeline.normalizeOptions('claude', { [checked.id]: { account: 'qwen' } });
  assert.deepEqual(options, { [checked.id]: { account: 'qwen', model: 'default', effort: 'default', trustFolder: false } });
  // An orchestrator's spawn_agent launchOptions reach the plugin because it declared them delegable.
  assert.deepEqual(pipeline.normalizeOptions('claude', { [checked.id]: { account: 'qwen' } }, { delegated: true }), options);
  const prepared = await pipeline.prepare({ sessionId: 'e2e', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, environment: null, options });
  assert.equal(prepared.ok, true, prepared.reason);
  assert.equal(prepared.env.ANTHROPIC_BASE_URL, ollama.url);
  assert.equal(prepared.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.5:9b:local');
  assert.ok(prepared.args.includes('--model'));
  await prepared.cleanup();
});

test('through CanvasTTY\'s launch pipeline: OpenCode gets the pinned provider config; an OpenRouter subagent is refused (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  const checked = validatePluginManifest(manifest);
  const storage = { accounts: { settings: { version: 1, accounts: [
    { id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['opencode'] },
    { id: 'or', label: 'OR', preset: 'openrouter-openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3', agents: ['opencode'] }
  ] }, keyOrigins: {} } };
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: { storageGet: async (_plugin, key) => storage[key] ?? null, storageSet: async (_plugin, key, value) => { storage[key] = value; }, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'accounts.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'accounts', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    dataDir: join(base, 'core-data-opencode'), permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'accounts', launch: checked.services[0].launch, secrets: true }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot: join(base, 'runs-opencode')
  });
  const launch = (account, role) => pipeline.prepare({ sessionId: `oc-${account}-${role}`, provider: 'opencode', profile: 'normal', role, cwd: project, restoring: false, resume: false,
    environment: null, options: pipeline.normalizeOptions('opencode', { [checked.id]: { account } }, { delegated: role === 'subagent' }) });
  const refused = await launch('or', 'subagent');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /OpenRouter is for Jev's decisions only/);
  const prepared = await launch('qwen', 'subagent');
  assert.equal(prepared.ok, true, prepared.reason);
  const config = JSON.parse(readFileSync(prepared.env.OPENCODE_CONFIG, 'utf8'));
  const [providerId] = Object.keys(config.provider);
  assert.deepEqual(config.enabled_providers, [providerId]);
  assert.equal(config.small_model, config.model);
  assert.equal(config.model, `${providerId}/qwen3.5:9b:local`);
  await prepared.cleanup();
});

test('through CanvasTTY\'s launch pipeline: pool:glm and pool:minimax for Claude Code and OpenCode, the key only in the environment (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  // An account saved earlier with the Z.AI preset, and a MiniMax China plan account: both in their plan pools.
  const storage = { accounts: { settings: { version: 1, accounts: [
    { id: 'glm-old', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
    { id: 'mm', label: 'MiniMax', preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.cn/anthropic', model: 'MiniMax-M3.1-Flash', agents: ['claude', 'opencode'], trust: 'D1', concurrency: 2 }
  ] }, keyOrigins: { 'glm-old': 'https://api.z.ai', mm: 'https://api.minimax.cn' } } };
  const secrets = { 'key.glm-old': `${KEY}-glm`, 'key.mm': `${KEY}-mm` };
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: { storageGet: async (_plugin, key) => storage[key] ?? null, storageSet: async (_plugin, key, value) => { storage[key] = value; }, secretGet: async (_plugin, key) => secrets[key] ?? null, emit: () => undefined }
  });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'accounts.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'accounts', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    dataDir: join(base, 'core-data-plans'), permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'accounts', launch: checked.services[0].launch, secrets: true }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async (_plugin, key) => secrets[key] ?? null,
    runsRoot: join(base, 'runs-plans')
  });
  const listed = (await pipeline.fieldOptions(checked.id, 'opencode')).account.map(option => option.value);
  assert.deepEqual(listed, ['glm-old', 'mm', 'pool:glm', 'pool:minimax']);
  // The launcher's Model: the plans' models (bundled lists here); the account saved with glm-4.6 runs the newest one.
  assert.deepEqual((await pipeline.fieldOptions(checked.id, 'claude')).model.map(option => option.value), ['glm-5.3', 'glm-5.3-flash', 'MiniMax-M3.1-Flash', 'MiniMax-M3']);
  const chosen = await pipeline.prepare({ sessionId: 'plan-0', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    environment: null, options: pipeline.normalizeOptions('claude', { [checked.id]: { account: 'pool:glm', model: 'glm-5.3-flash' } }) });
  assert.equal(chosen.ok, true, chosen.reason);
  assert.equal(chosen.env.ANTHROPIC_MODEL, 'glm-5.3-flash');
  await chosen.cleanup();
  const launch = (provider, account, session) => pipeline.prepare({ sessionId: session, provider, profile: 'normal', role: 'subagent', cwd: project, restoring: false, resume: false,
    environment: null, options: pipeline.normalizeOptions(provider, { [checked.id]: { account } }, { delegated: true }) });
  const claude = await launch('claude', 'pool:glm', 'plan-1');
  assert.equal(claude.ok, true, claude.reason);
  assert.deepEqual([claude.env.ANTHROPIC_MODEL, claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, `${KEY}-glm`);
  assert.deepEqual(claude.secrets, [`${KEY}-glm`], 'CanvasTTY masks it for the session');
  assert.ok(!claude.args.join(' ').includes(KEY));
  const opencode = await launch('opencode', 'pool:minimax', 'plan-2');
  assert.equal(opencode.ok, true, opencode.reason);
  const text = readFileSync(opencode.env.OPENCODE_CONFIG, 'utf8');
  assert.ok(!text.includes(KEY), 'the config names the variable, not the key');
  const config = JSON.parse(text);
  const [providerId] = Object.keys(config.provider);
  assert.deepEqual(config.enabled_providers, [providerId]);
  assert.equal(config.provider[providerId].options.baseURL, 'https://api.minimax.cn/anthropic/v1');
  assert.equal(opencode.env.CTTY_MODEL_API_KEY, `${KEY}-mm`);
  assert.ok(!opencode.args.join(' ').includes(KEY));
  await claude.cleanup();
  await opencode.cleanup();
});

test('over JSON-RPC: a storage read that fails at start is retried, and nothing is saved over the accounts meanwhile', async (t) => {
  const storage = { accounts: { settings: { version: 1, accounts: [{ id: 'qwen', label: 'Qwen', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude'] }] }, keyOrigins: {} } };
  const saved = structuredClone(storage.accounts);
  let failures = 2;
  const service = startService(t, { dataDir: join(base, 'data-unread'), host: {
    'storage.get': ({ key }) => { if (key === 'accounts' && failures-- > 0) throw new Error('host busy'); return storage[key] ?? null; },
    'storage.set': ({ key, value }) => { storage[key] = value; },
    'secrets.get': () => null
  } });
  await assert.rejects(service.request('save', { settings: { version: 1, accounts: [] } }), /could not be read/);
  assert.deepEqual(storage.accounts, saved);
  assert.deepEqual((await service.request('state')).settings.accounts.map(account => account.id), ['qwen']);
});

test('over JSON-RPC: a pool account is added, its sign-in card opens through sessions.create, and a pool launch gets its home', async (t) => {
  const storage = {};
  const dataDir = join(base, 'data-pools');
  const created = [];
  const calls = [];
  const service = startService(t, { dataDir, host: {
    'storage.get': ({ key }) => storage[key] ?? null,
    'storage.set': ({ key, value }) => { storage[key] = value; },
    'secrets.get': () => null,
    'sessions.subscribe': () => { calls.push('sessions.subscribe'); return { sessions: [] }; },
    'sessions.create': params => { created.push(params); return { sessionId: `card-${created.length}` }; },
    'limits.get': params => { calls.push(`limits.get ${params.provider}`); throw new Error('Unknown host method: limits.get.'); }
  } });
  await assert.rejects(service.request('poolAdd', { provider: 'grok', label: 'Grok 1' }), /trust/);
  const added = await service.request('poolAdd', { provider: 'grok', label: 'Grok 1', trust: 'unset' });
  assert.deepEqual(added.signIn, { sessionId: 'card-1' });
  const home = join(dataDir, 'pools', added.id);
  const signIn = await service.request('canvastty.launch.prepare', { sessionId: 'card-1', provider: 'grok', profile: 'normal', role: 'agent', cwd: base, restoring: false, resume: false, chosen: true, environment: null, options: created[0].launchOptions['canvastty-accounts'] });
  assert.deepEqual(signIn.env, { GROK_HOME: home });
  // The sign-in ends (a fake credential appears in the home, as the CLI would write it).
  writeFileSync(join(home, 'auth.json'), '{}', { mode: 0o600 });
  service.notify('canvastty.sessions.event', { type: 'closed', session: { id: 'card-1' } });
  await new Promise(resolve => setTimeout(resolve, 100));
  const state = await service.request('state');
  const member = state.pools.providers.find(entry => entry.provider === 'grok').accounts[0];
  assert.equal(member.signIn, 'signed-in');
  assert.equal(state.pools.limits, 'no', 'an older CanvasTTY without per-home limits is detected');
  assert.deepEqual((await service.request('canvastty.launch.options', { provider: 'grok' })).account.map(option => option.value), ['pool:grok', `sub:${added.id}`]);
  const launch = await service.request('canvastty.launch.prepare', { sessionId: 'card-2', provider: 'grok', profile: 'normal', role: 'subagent', cwd: base, restoring: false, resume: false, chosen: true, environment: null, options: { account: 'pool:grok', effort: 'high' } });
  assert.deepEqual(launch.env, { GROK_HOME: home });
  assert.deepEqual(launch.args, ['--reasoning-effort', 'high']);
  assert.ok(calls.includes('sessions.subscribe'));
  assert.deepEqual(storage.pools.accounts.map(account => account.id), [added.id]);
});

test('through CanvasTTY\'s own supervisor and launch pipeline: a pool sign-in card and pool launches get the account home (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  const storage = {};
  const created = [];
  const dataDir = join(base, 'core-pools-data');
  const supervisor = new PluginServiceSupervisor({
    command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: {
      storageGet: async (_plugin, key) => storage[key] ?? null, storageSet: async (_plugin, key, value) => { storage[key] = value; }, emit: () => undefined,
      sessions: (_plugin, _service, method, params) => {
        if (method === 'sessions.subscribe') return { sessions: [] };
        if (method === 'sessions.create') { created.push(params); return { sessionId: `card-${created.length}` }; }
        return undefined;
      }
    }
  });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'accounts.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'accounts', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'),
    dataDir, permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'accounts', launch: checked.services[0].launch, secrets: true, dataDir }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot: join(base, 'runs-pools')
  });
  const added = await supervisor.request(checked.id, 'accounts', 'poolAdd', { provider: 'kimi', label: 'Kimi 1', trust: 'D2' });
  assert.deepEqual(added.signIn, { sessionId: 'card-1' });
  const home = join(dataDir, 'pools', added.id);
  const signInOptions = pipeline.normalizeOptions('kimi', created[0].launchOptions);
  const signIn = await pipeline.prepare({ sessionId: 'card-1', provider: 'kimi', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, environment: null, options: signInOptions });
  assert.equal(signIn.ok, true, signIn.reason);
  assert.equal(signIn.env.KIMI_CODE_HOME, home);
  // A core that knows Kimi Code's home variable registers it as the launch's account home (isolation reopens it).
  const registers = readFileSync(join(repo, 'src/main/services/LaunchPipeline.ts'), 'utf8').includes('contributedAccountHome');
  if (registers) assert.equal(signIn.accountHome, readFileSync(join(repo, 'src/main/services/isolation/isolationPaths.ts'), 'utf8').includes('"KIMI_CODE_HOME"') ? home : undefined);
  await signIn.cleanup();
  // The CLI's sign-in writes its credential into the home (simulated); the card ends.
  mkdirSync(join(home, 'credentials'), { recursive: true });
  writeFileSync(join(home, 'credentials', 'kimi-code.json'), '{}', { mode: 0o600 });
  assert.equal(supervisor.notify(checked.id, 'accounts', 'canvastty.sessions.event', { type: 'closed', session: { id: 'card-1' } }), true);
  await new Promise(resolve => setTimeout(resolve, 200));
  // An orchestrator's pool choice reaches the plugin (delegable), and the pool picks the account.
  assert.deepEqual((await pipeline.fieldOptions(checked.id, 'kimi')).account.map(option => option.value), ['pool:kimi', `sub:${added.id}`]);
  const delegated = pipeline.normalizeOptions('kimi', { [checked.id]: { account: 'pool:kimi' } }, { delegated: true });
  const launch = await pipeline.prepare({ sessionId: 'sub-1', provider: 'kimi', profile: 'normal', role: 'subagent', cwd: project, restoring: false, resume: false, environment: null, options: delegated });
  assert.equal(launch.ok, true, launch.reason);
  assert.equal(launch.env.KIMI_CODE_HOME, home);
  await launch.cleanup();
});

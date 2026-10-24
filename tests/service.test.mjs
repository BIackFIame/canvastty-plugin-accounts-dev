// The Accounts service against a fake host (storage, secrets) and a fake Ollama: the launcher list, the launch
// contribution per account, the refusals, «Проверить», the key's address binding and the orchestrator tools.
// Keys are assembled at runtime; nothing leaves 127.0.0.1.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService, thirdPartyModel } from '../src/service/accounts.ts';
import { seedClaudeHome } from '../src/launch/homes.ts';
import { listRoutes } from '../src/routes/routes.ts';
import { startFakeOllama } from './helpers/fake-ollama.mjs';

const KEY = ['sk', 'fixture', 'glm', 'f00dfeed'.repeat(4)].join('-');

async function fixture(t, { ollama: ollamaOptions } = {}) {
  const ollama = await startFakeOllama(ollamaOptions);
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-accounts-data-'));
  const project = await mkdtemp(join(tmpdir(), 'canvastty-accounts-project-'));
  t.after(async () => { await ollama.close(); await rm(dataDir, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  const storage = {};
  const secrets = {};
  const logs = [];
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: () => undefined
  };
  const service = new AccountsService({ host, dataDir });
  const accounts = [
    { id: 'qwen-local', label: 'Qwen local', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude', 'codex', 'opencode'] },
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude', 'opencode'] }
  ];
  await service.save({ version: 1, accounts });
  const context = (patch = {}) => ({ sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    chosen: true, environment: null, ...patch, options: { account: 'qwen-local', effort: 'default', trustFolder: false, ...patch.options } });
  return { ollama, dataDir, project, storage, secrets, logs, service, host, context, reload: () => new AccountsService({ host, dataDir, saved: storage.accounts }) };
}

test('the launcher lists the accounts the person allowed for each agent', async (t) => {
  const { service } = await fixture(t);
  // The Z.AI account is a GLM Coding Plan account: listed by name and as the plan's pool for Claude Code and OpenCode.
  assert.deepEqual(service.launchOptions('claude'), { account: [{ value: 'qwen-local', label: 'Qwen local · qwen3.5:9b' }, { value: 'glm', label: 'GLM · glm-4.6' },
    { value: 'pool:glm', label: 'GLM Coding Plan pool · the account with the most room (1)' }] });
  assert.deepEqual(service.launchOptions('codex').account.map(option => option.value), ['qwen-local']);
  assert.deepEqual(service.launchOptions('qwen'), { account: [] });
  assert.deepEqual(service.launchOptions('terminal'), { account: [] });
});

test('Claude Code on local Ollama: pinned model, the account home seeded, nothing written outside the plugin folder', async (t) => {
  const { service, dataDir, ollama, project } = await fixture(t);
  const answer = await service.prepare({ ...contextFor(project), options: { account: 'qwen-local', effort: 'high', trustFolder: true } });
  assert.equal(answer.env.ANTHROPIC_BASE_URL, ollama.url);
  assert.equal(answer.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.5:9b:local');
  const home = join(dataDir, 'homes', 'claude-qwen-local');
  assert.equal(answer.env.CLAUDE_CONFIG_DIR, home);
  assert.deepEqual(answer.args.slice(-2), ['--effort', 'high']);
  assert.ok(answer.args.includes('--disallowedTools'), 'the server has cloud features on: web search off');
  assert.equal(answer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '262144');
  const seeded = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
  assert.equal(seeded.hasCompletedOnboarding, true);
  assert.equal(seeded.projects[project].hasTrustDialogAccepted, true);
  assert.deepEqual(await readdir(project), [], 'the project folder is untouched');
  // Read-only against Ollama: no pull, no generate, no load.
  assert.ok(ollama.requests.every(request => request.method === 'GET' || request.path === '/api/show'));
  assert.ok(ollama.requests.some(request => request.path === '/api/show' && request.body.model === 'qwen3.5:9b:local'));
});

function contextFor(cwd, patch = {}) {
  return { sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd, restoring: false, resume: false, chosen: true, environment: null, ...patch };
}

test('Codex on local Ollama: the account CODEX_HOME, a private catalog, and a subagent cannot pre-trust a folder', async (t) => {
  const { service, dataDir, context, project } = await fixture(t);
  const person = await service.prepare(context({ provider: 'codex', options: { trustFolder: true, effort: 'low' } }));
  assert.equal(person.env.CODEX_HOME, join(dataDir, 'homes', 'codex-qwen-local'));
  assert.ok(person.args.includes(`projects={${JSON.stringify(project)}={trust_level="trusted"}}`));
  assert.deepEqual(person.args.slice(-4), ['--model', 'qwen3.5:9b:local', '-c', 'model_reasoning_effort="low"']);
  assert.equal(person.files[0].relPath, 'codex-model.json');
  const subagent = await service.prepare(context({ provider: 'codex', role: 'subagent', options: { trustFolder: true } }));
  assert.ok(!subagent.args.some(arg => arg.startsWith('projects=')));
});

test('an account model is third-party: CanvasTTY runs "auto" as accept-edits; the vendor\'s own API is not', async (t) => {
  const { service, context } = await fixture(t);
  const local = await service.prepare(context({ profile: 'auto' }));
  assert.equal(local.thirdPartyModel, true);
  assert.equal((await service.prepare(context({ provider: 'codex', profile: 'auto' }))).thirdPartyModel, true);
  assert.equal(await service.prepare(context({ options: { account: 'none' } })), null, 'the agent\'s own sign-in is not marked');
  assert.equal(thirdPartyModel('claude', 'https://api.anthropic.com'), false);
  assert.equal(thirdPartyModel('codex', 'https://api.openai.com/v1'), false);
  assert.equal(thirdPartyModel('claude', 'https://api.z.ai/api/anthropic'), true);
  assert.equal(thirdPartyModel('codex', 'https://api.anthropic.com'), true);
  assert.equal(thirdPartyModel('claude', null), true);
});

test('delegated (an orchestrator chose the options): a subagent gets the account and effort, never folder trust or approval keys', async (t) => {
  const { service, dataDir, context, project } = await fixture(t);
  for (const provider of ['claude', 'codex', 'opencode']) {
    const answer = await service.prepare(context({ provider, role: 'subagent', options: { trustFolder: true, effort: provider === 'opencode' ? 'default' : 'high' } }));
    assert.equal(answer.refuse, undefined, provider);
    assert.ok(!answer.args.some(arg => arg.startsWith('projects=')), `${provider}: no folder trust`);
    assert.ok(!Object.keys(answer.env).some(name => /PERMISSION|CONFIG_DIR$/u.test(name) && name !== 'CLAUDE_CONFIG_DIR'), provider);
    for (const file of answer.files) assert.doesNotMatch(Object.keys(JSON.parse(file.content)).join(), /permission|approv|yolo|sandbox|bypass|trust/i, provider);
  }
  const seeded = JSON.parse(await readFile(join(dataDir, 'homes', 'claude-qwen-local', '.claude.json'), 'utf8'));
  assert.equal(seeded.projects?.[project], undefined, 'the account home does not trust the folder for a subagent');
});

test('a Claude subagent in the orchestrator\'s folder (CanvasTTY\'s trustedFolder) is trusted in the account home only', async (t) => {
  const { service, dataDir, context, project } = await fixture(t);
  const docs = join(project, 'docs');
  await mkdir(docs);
  const answer = await service.prepare(context({ role: 'subagent', cwd: docs, trustedFolder: docs, options: { trustFolder: true } }));
  assert.equal(answer.refuse, undefined);
  const seeded = JSON.parse(await readFile(join(dataDir, 'homes', 'claude-qwen-local', '.claude.json'), 'utf8'));
  assert.deepEqual(Object.keys(seeded.projects ?? {}), [docs], 'the model-chosen trustFolder option is still ignored; the host folder counts');
});

test('refusals: a missing account or agent, a non-local environment, a stopped Ollama, an uninstalled or tool-less model, a bad effort', async (t) => {
  const { service, context, ollama } = await fixture(t);
  assert.match((await service.prepare(context({ options: { account: 'gone' } }))).refuse.reason, /gone no longer exists/);
  assert.match((await service.prepare(context({ provider: 'qwen' }))).refuse.reason, /not set up for Qwen Code/);
  assert.match((await service.prepare(context({ environment: { pluginId: 'canvastty-environments', kind: 'ssh-host' } }))).refuse.reason, /on this computer/);
  assert.equal((await service.prepare(context({ environment: { pluginId: 'canvastty-environments', kind: 'worktree' } }))).refuse, undefined, 'a worktree is on this computer');
  assert.match((await service.prepare(context({ options: { effort: 'minimal' } }))).refuse.reason, /no reasoning effort "minimal"/);
  const accounts = service.settings.accounts;
  await service.save({ version: 1, accounts: [...accounts, { id: 'gemma', label: 'Gemma', preset: 'ollama-local', baseUrl: ollama.url, model: 'gemma3:12b', agents: ['claude'] },
    { id: 'absent', label: 'Absent', preset: 'ollama-local', baseUrl: ollama.url, model: 'llama9:1b', agents: ['claude'] }] });
  assert.match((await service.prepare(context({ options: { account: 'gemma' } }))).refuse.reason, /no tool calling/);
  assert.match((await service.prepare(context({ options: { account: 'absent' } }))).refuse.reason, /not installed.*ollama pull llama9:1b/);
  await ollama.close();
  assert.match((await service.prepare(context({}))).refuse.reason, /Ollama is not running/);
  // Not chosen (a policy check) and the agent's own sign-in with nothing to add: no contribution.
  assert.equal(await service.prepare(context({ chosen: false })), null);
  assert.equal(await service.prepare(context({ options: { account: 'none' } })), null);
  assert.deepEqual((await service.prepare(context({ provider: 'codex', options: { account: 'none', effort: 'high', trustFolder: true } }))).args.slice(0, 2), ['-c', 'model_reasoning_effort="high"']);
});

test('a keyed account: the key goes by name only, is bound to the address it was saved for, and a project cannot redirect it', async (t) => {
  const { service, secrets, context, project, reload } = await fixture(t);
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /GLM has no key/);
  secrets['key.glm'] = KEY;
  // Saved without the page's keyChanged (another address or an old key): refused until saved again.
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /another address/);
  await service.keyChanged('glm');
  const answer = await service.prepare(context({ options: { account: 'glm' } }));
  assert.deepEqual(answer.secretEnv, { ANTHROPIC_AUTH_TOKEN: 'key.glm' });
  assert.ok(!JSON.stringify(answer).includes(KEY), 'the value never travels through the contribution');
  // The binding survives a restart of the service.
  assert.ok((await reload().prepare(context({ options: { account: 'glm' } }))).secretEnv);
  // OpenCode on the same account: {env:…} in its private config.
  const opencode = await service.prepare(context({ provider: 'opencode', options: { account: 'glm' } }));
  assert.equal(JSON.parse(opencode.files[0].content).provider[Object.keys(JSON.parse(opencode.files[0].content).provider)[0]].options.baseURL, 'https://api.z.ai/api/anthropic/v1');
  // A project that sets its own route is refused for a keyed Claude account.
  await mkdir(join(project, '.claude'));
  await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://collector.test' } }));
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /sets ANTHROPIC_BASE_URL/);
  await rm(join(project, '.claude'), { recursive: true });
  // A bad key (pasted with a space) is refused with the person's message.
  secrets['key.glm'] = `${KEY} x`;
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /space or line break/);
  secrets['key.glm'] = KEY;
  // Moving the account to another address unbinds the key.
  await service.save({ version: 1, accounts: service.settings.accounts.map(entry => entry.id === 'glm' ? { ...entry, preset: 'custom-anthropic', baseUrl: 'https://proxy.test/anthropic' } : entry) });
  assert.match((await service.prepare(context({ options: { account: 'glm' } }))).refuse.reason, /another address/);
  assert.equal((await service.state()).keys.glm, 'other-address');
});

test('«Проверить»: Ollama lists its models (read-only); a key gets a format check only, nothing is sent', async (t) => {
  const { service, secrets, ollama } = await fixture(t);
  const local = await service.check('qwen-local');
  assert.equal(local.kind, 'ollama');
  assert.equal(local.running, true);
  assert.deepEqual(local.models.map(model => [model.name, model.tools]), [['qwen3.5:9b', true], ['gemma3:12b', false]]);
  assert.deepEqual(local.model, { installed: true, tools: true });
  const before = ollama.requests.length;
  assert.deepEqual(await service.check('glm'), { kind: 'key', ok: false, problem: 'No key is saved.' });
  secrets['key.glm'] = 'short';
  await service.keyChanged('glm');
  assert.match((await service.check('glm')).problem, /shorter/);
  secrets['key.glm'] = KEY;
  assert.deepEqual(await service.check('glm'), { kind: 'key', ok: true, problem: null });
  assert.equal(ollama.requests.length, before, 'checking a key contacts nothing');
  assert.equal((await service.state()).checks.glm.ok, true);
});

test('removing an account removes its agent homes and its key binding', async (t) => {
  const { service, dataDir, context, secrets } = await fixture(t);
  await service.prepare(context({}));
  secrets['key.glm'] = KEY;
  await service.keyChanged('glm');
  await service.save({ version: 1, accounts: [] });
  assert.deepEqual(await readdir(join(dataDir, 'homes')), []);
  assert.deepEqual((await service.state()).keys, {});
  assert.deepEqual(service.launchOptions('claude'), { account: [] });
});

test('orchestrator tools: list_routes says what is ready and why not; pick_account skips accounts that cannot work now', async (t) => {
  const { service, secrets, ollama } = await fixture(t);
  await service.save({ version: 1, accounts: [
    { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
    { id: 'gone-model', label: 'Llama', preset: 'ollama-local', baseUrl: ollama.url, model: 'llama9:1b', agents: ['claude'] },
    ...service.settings.accounts.filter(entry => entry.id === 'qwen-local')
  ] });
  const listed = (await service.tool('list_routes', { provider: 'claude' })).content;
  assert.deepEqual(listed.routes.map(row => [row.accountId, row.state]), [['glm', 'no-key'], ['gone-model', 'model-missing'], ['qwen-local', 'ready']]);
  assert.deepEqual(listed.routes[2].launchOptions, { 'canvastty-accounts': { account: 'qwen-local', effort: 'default', trustFolder: false } });
  assert.equal(listed.routes[0].launchOptions, undefined);
  assert.ok(!JSON.stringify(listed).includes(ollama.url.split(':')[2] + '/'), 'no paths');
  const pick = (await service.tool('pick_account', { provider: 'claude', effort: 'high' })).content;
  assert.equal(pick.accountId, 'qwen-local');
  assert.deepEqual(pick.spawn, { provider: 'claude', launchOptions: { 'canvastty-accounts': { account: 'qwen-local', effort: 'high', trustFolder: false } } });
  // The GLM account is a coding plan (tried before model accounts): without a key it is skipped there.
  assert.match(pick.why, /skipped Llama \(llama9:1b\): llama9:1b is not installed/);
  assert.equal(listed.routes[0].kind, 'subscription');
  secrets['key.glm'] = KEY;
  await service.keyChanged('glm');
  const plan = (await service.tool('pick_account', { provider: 'claude' })).content;
  assert.deepEqual([plan.accountId, plan.kind, plan.plan], ['glm', 'subscription', 'glm'], 'a working plan account comes before model accounts');
  assert.equal((await service.tool('pick_account', { provider: 'claude', source: 'accounts' })).content.accountId, 'qwen-local', 'model accounts only');
  assert.equal((await service.tool('pick_account', { provider: 'claude', model: 'qwen' })).content.accountId, 'qwen-local');
  const none = await service.tool('pick_account', { provider: 'kimi' });
  assert.equal(none.isError, true);
  assert.match(none.content, /No model account for Kimi: the person set up none.*own sign-in/);
  await ollama.close();
  const down = await service.tool('pick_account', { provider: 'codex' });
  assert.match(down.content, /Qwen local \(qwen3\.5:9b\): Ollama is not running/);
  assert.equal((await service.tool('pick_account', {})).isError, true);
});

test('orchestrator tools: a route on an Ollama too old for the launch is not ready, with the launch\'s own reason', async (t) => {
  const { service, context } = await fixture(t, { ollama: { version: '0.17.2' } });
  const listed = (await service.tool('list_routes', { provider: 'claude' })).content;
  const row = listed.routes.find(entry => entry.accountId === 'qwen-local');
  assert.equal(row.state, 'ollama-old');
  const refused = await service.prepare(context());
  assert.equal(refused.refuse.reason, row.reason);
  assert.equal(row.launchOptions, undefined);
});

test('orchestrator tools: list_routes checks the effort like pick_account does', async (t) => {
  const { service } = await fixture(t);
  const listed = (await service.tool('list_routes', { effort: 'max' })).content.routes;
  assert.deepEqual(listed.filter(row => row.accountId === 'qwen-local').map(row => [row.provider, row.state]), [['claude', 'ready'], ['codex', 'no-effort'], ['opencode', 'no-effort']]);
  assert.equal(listed.find(row => row.provider === 'claude').launchOptions['canvastty-accounts'].effort, 'max');
  const unknown = await service.tool('list_routes', { effort: 'extreme' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /no reasoning effort "extreme"/);
  assert.match((await service.tool('pick_account', { provider: 'claude', effort: 'extreme' })).content, /no reasoning effort "extreme"/);
});

test('routes: accounts are probed a few at a time, in order, and one no agent asked for is not probed', async () => {
  const accounts = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `A${i}`, preset: 'custom-anthropic', baseUrl: 'https://llm.example.test/anthropic', model: 'glm-4.6', agents: [i === 8 ? 'opencode' : 'claude'] }));
  let active = 0, most = 0;
  const asked = [];
  const facts = {
    key: async account => { asked.push(account.id); active++; most = Math.max(most, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return 'ok'; },
    ollama: async () => { throw new Error('not used'); }
  };
  const rows = await listRoutes(accounts, facts, { provider: 'claude' });
  assert.deepEqual(rows.map(row => row.accountId), accounts.slice(0, 8).map(account => account.id));
  assert.equal(asked.includes('a8'), false);
  assert.ok(most > 1 && most <= 4, `at most four at once (${most})`);
});

test('«Проверить» that finishes after its account changed does not show its old result', async (t) => {
  const ollama = await startFakeOllama();
  t.after(() => ollama.close());
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-accounts-check-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = {};
  const host = { callHost: async (method, params) => { if (method === 'storage.set') { storage[params.key] = params.value; return null; } return null; }, log() {}, emit() {} };
  const service = new AccountsService({ host, dataDir, transport: async (url, init) => { await gate; return fetch(url, init); } });
  const account = { id: 'local', label: 'Local', preset: 'ollama-local', baseUrl: ollama.url, model: 'qwen3.5:9b', agents: ['claude'] };
  await service.save({ version: 1, accounts: [account] });
  const checking = service.check('local');
  await service.save({ version: 1, accounts: [{ ...account, model: 'gemma3:12b' }] });
  release();
  assert.equal((await checking).kind, 'ollama');
  assert.deepEqual((await service.state()).checks, {}, 'the result was for the old model');
});

test('the account\'s Claude settings: a missing file is seeded, a broken one is kept aside, an unreadable one is not replaced', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'canvastty-accounts-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, '.claude.json');
  await seedClaudeHome(home, []);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hasCompletedOnboarding, true);
  await writeFile(path, '{"projects": {', { mode: 0o600 });
  await seedClaudeHome(home, []);
  assert.equal(await readFile(`${path}.unreadable`, 'utf8'), '{"projects": {');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hasCompletedOnboarding, true);
  if (process.getuid?.() !== 0) {
    await writeFile(path, '{"keep": true}', { mode: 0o600 });
    await chmod(path, 0o000);
    await assert.rejects(seedClaudeHome(home, [home]), /cannot be read/);
    await chmod(path, 0o600);
    assert.equal(await readFile(path, 'utf8'), '{"keep": true}');
  }
});

test('storage that cannot be read at start is not "nothing saved": no empty list is shown or saved over the accounts', async (t) => {
  const { storage, dataDir, host } = await fixture(t);
  const saved = structuredClone(storage.accounts);
  let broken = true;
  const flaky = { ...host, callHost: async (method, params) => {
    if (broken && method === 'storage.get') throw new Error('host busy');
    return host.callHost(method, params);
  } };
  const service = new AccountsService({ host: flaky, dataDir, unread: true });
  await assert.rejects(service.load(), /could not be read/);
  await assert.rejects(service.save({ version: 1, accounts: [{ id: 'new', label: 'New', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude'] }] }), /could not be read/);
  assert.deepEqual(storage.accounts, saved, 'nothing was written over the saved accounts');
  broken = false;
  await service.load();
  assert.deepEqual((await service.state()).settings.accounts.map(account => account.id), ['qwen-local', 'glm']);
});

test('a save or key binding the host fails to store changes nothing in memory or on disk', async (t) => {
  const { service, storage, dataDir, host, secrets, context } = await fixture(t);
  await service.prepare(context({}));
  secrets['key.glm'] = KEY;
  await service.keyChanged('glm');
  const before = structuredClone(storage.accounts);
  const real = host.callHost;
  host.callHost = async (method, params) => { if (method === 'storage.set') throw new Error('disk full'); return real(method, params); };
  await assert.rejects(service.save({ version: 1, accounts: [] }));
  assert.deepEqual(service.settings, before.settings, 'the accounts in memory are the saved ones');
  assert.equal((await service.state()).keys.glm, 'ok', 'the key binding is still the saved one');
  assert.deepEqual(await readdir(join(dataDir, 'homes')), ['claude-qwen-local'], 'a removal that was not saved keeps the account home');
  delete secrets['key.glm'];
  await assert.rejects(service.keyChanged('glm'));
  secrets['key.glm'] = KEY;
  assert.equal((await service.state()).keys.glm, 'ok', 'a binding change that was not saved is not in memory');
  assert.deepEqual(storage.accounts, before);
});

test('the settings page reads every account\'s key at once, not one after another', async (t) => {
  const { service, host } = await fixture(t);
  const accounts = Array.from({ length: 6 }, (_, n) => ({ id: `k${n}`, label: `K${n}`, preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] }));
  await service.save({ version: 1, accounts });
  const real = host.callHost;
  let running = 0, most = 0;
  host.callHost = async (method, params) => {
    if (method !== 'secrets.get') return real(method, params);
    running++; most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    return null;
  };
  const state = await service.state();
  assert.deepEqual(Object.values(state.keys), Array(6).fill('missing'));
  assert.equal(most, 6);
});

test('an Ollama answer without Content-Length is cut off at the size cap while it is read', async () => {
  const { ollamaHttp } = await import('../src/launch/ollama.ts');
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const transport = async () => new Response(new ReadableStream({
    pull(controller) { if (pulled >= 16 * 1024 * 1024) { controller.close(); return; } pulled += chunk.byteLength; controller.enqueue(chunk); }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const answer = await ollamaHttp('http://127.0.0.1:1', transport)('GET', '/api/tags');
  assert.deepEqual(answer, { status: 200, json: null });
  assert.ok(pulled <= 4 * 1024 * 1024 + 3 * chunk.byteLength, `read ${pulled} bytes`);
  // A small body without the header still parses.
  const small = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"version":"0.12.0"}')); controller.close(); } }), { status: 200 });
  assert.deepEqual(await ollamaHttp('http://127.0.0.1:1', small)('GET', '/api/version'), { status: 200, json: { version: '0.12.0' } });
});

test('OpenRouter accounts: refused for a subagent, still the person\'s own choice, never offered as a route', async (t) => {
  const { service, secrets, context, host } = await fixture(t);
  await service.save({ version: 1, accounts: [
    { id: 'or', label: 'OR', preset: 'openrouter-anthropic', baseUrl: 'https://openrouter.ai/api', model: 'z-ai/glm-4.6', agents: ['claude', 'opencode'] },
    { id: 'or-custom', label: 'OR custom', preset: 'custom-openai', baseUrl: 'https://eu.openrouter.ai/api/v1', model: 'z-ai/glm-4.6', agents: ['opencode'] },
    ...service.settings.accounts
  ] });
  secrets['key.or'] = KEY; secrets['key.or-custom'] = KEY; secrets['key.glm'] = KEY;
  for (const id of ['or', 'or-custom', 'glm']) await service.keyChanged(id);

  // Delegated launches (an orchestrator's or Auto's spawn_agent): refused before the key is read.
  const real = host.callHost;
  const reads = [];
  host.callHost = async (method, params) => { if (method === 'secrets.get') reads.push(params.key); return real(method, params); };
  for (const [provider, account] of [['claude', 'or'], ['opencode', 'or'], ['opencode', 'or-custom']]) {
    const refused = await service.prepare(context({ provider, role: 'subagent', options: { account } }));
    assert.match(refused.refuse.reason, /cannot run a subagent: OpenRouter is for Jev's decisions only/, `${provider} ${account}`);
  }
  assert.deepEqual(reads, [], 'no key read for a refused delegated launch');
  host.callHost = real;

  // The person's own launch keeps working, and the launcher still lists the account.
  const person = await service.prepare(context({ provider: 'opencode', options: { account: 'or' } }));
  assert.equal(person.refuse, undefined);
  assert.match(JSON.parse(person.files[0].content).provider[Object.keys(JSON.parse(person.files[0].content).provider)[0]].options.baseURL, /^https:\/\/openrouter\.ai\//);
  assert.ok(service.launchOptions('opencode').account.some(option => option.value === 'or'));
  // A subagent on a non-OpenRouter account is unaffected.
  const glm = await service.prepare(context({ provider: 'opencode', role: 'subagent', options: { account: 'glm' } }));
  assert.equal(glm.refuse, undefined);
  assert.deepEqual(glm.secretEnv, { CTTY_MODEL_API_KEY: 'key.glm' });

  // Routes: marked, never ready, no launchOptions; pick_account skips them even though they come first.
  const listed = (await service.tool('list_routes', { provider: 'opencode' })).content.routes;
  assert.deepEqual(listed.map(row => [row.accountId, row.state]), [['or', 'decisions-only'], ['or-custom', 'decisions-only'], ['qwen-local', 'ready'], ['glm', 'ready']]);
  for (const row of listed.slice(0, 2)) {
    assert.equal(row.launchOptions, undefined);
    assert.match(row.reason, /Jev's decisions only/);
  }
  const pick = (await service.tool('pick_account', { provider: 'opencode', source: 'accounts' })).content;
  assert.equal(pick.accountId, 'qwen-local');
  assert.match(pick.why, /skipped OR \(z-ai\/glm-4\.6\): OpenRouter is for Jev's decisions only/);
  // With only OpenRouter accounts there is no route at all.
  await service.save({ version: 1, accounts: service.settings.accounts.filter(entry => entry.id.startsWith('or')) });
  const none = await service.tool('pick_account', { provider: 'opencode' });
  assert.equal(none.isError, true);
  assert.match(none.content, /none is ready: OR .*decisions only/);
});

// Coding-plan model lists against a fake host and a fake network answering with hand-written fixtures: parsing the
// providers' lists, the newest main and small model, the per-account cache with its daily refresh and "Read now", the
// bundled fallback, accounts saved with old models following the list (with a notice said once), the launcher's Model
// choice, routes, shares and broker offers with the list, and the key: sent only to the account's own host, never in a
// file, log, answer or error. No provider is contacted and no real key is used: every key is assembled at runtime.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService } from '../src/service/accounts.ts';
import { BUNDLED_MODELS, defaultModels, olderThanList, parseModel, parseModelList, sortModels } from '../src/plans/models.ts';
import { modelsUrlOf, MODELS_FILE } from '../src/plans/modelReader.ts';
import { newPlanAccount, PLAN_INFO } from '../src/plans/plans.ts';
import { matchModel } from '../src/routes/routes.ts';
import { validateAccount } from '../src/shared/accounts.ts';

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const H = 3_600_000;
const KEY = ['plan', 'fixture', 'beef'.repeat(6)].join('.');
const fixtureJson = async path => JSON.parse(await readFile(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'));

async function fixture(t, { answers = () => ({ status: 404, body: {} }), saved, network = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-models-data-'));
  const project = await mkdtemp(join(tmpdir(), 'canvastty-models-project-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  const storage = {};
  const secrets = {};
  const logs = [];
  const calls = [];
  const clock = { now: NOW };
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      if (method === 'sessions.subscribe') return { sessions: [] };
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: () => undefined
  };
  const modelsFetch = async (url, init) => {
    calls.push({ url, init });
    const next = await answers(url, init);
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
  };
  const make = value => new AccountsService({ host, dataDir, now: () => clock.now, random: () => 0.5, ...(network ? { modelsFetch } : {}), ...(value ? { saved: value } : {}) });
  const service = make(saved);
  await service.load();
  const setKey = async (id, value = KEY) => { secrets[`key.${id}`] = value; await service.keyChanged(id); };
  const context = (patch = {}) => ({ sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    chosen: true, environment: null, ...patch, options: { account: 'pool:glm', effort: 'default', trustFolder: false, ...patch.options } });
  /** The background reads a key change starts, settled. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    // Waits for the reads in flight (stop() also writes the file; the reader still answers tick() and read() after it).
    await service.models.stop();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { service, storage, secrets, logs, calls, clock, dataDir, make, setKey, context, settle };
}

const glm = (id, patch = {}) => ({ ...newPlanAccount({ id, provider: 'glm', region: 'intl', label: id.toUpperCase(), trust: 'D1' }), ...patch });
const minimax = (id, patch = {}) => ({ ...newPlanAccount({ id, provider: 'minimax', region: 'intl', label: id.toUpperCase(), trust: 'D1' }), ...patch });
const glmList = ids => ({ body: { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'z-ai' })) } });

// ---------------------------------------------------------------------------------------------------------------
// Pure: parsing and the newest model
// ---------------------------------------------------------------------------------------------------------------

test('model lists: only the plan\'s text models are kept, newest first (MiniMax\'s documented list, GLM\'s OpenAI shape)', async () => {
  assert.deepEqual(parseModelList('minimax', await fixtureJson('minimax/models-list.json')), ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']);
  assert.deepEqual(parseModelList('glm', await fixtureJson('zai/models-list.json')), ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.6', 'glm-4.5-air']);
  assert.equal(parseModelList('glm', { data: [{ id: 'cogview-4' }, { id: 'glm-4.6v' }] }), null, 'no coding model');
  assert.equal(parseModelList('glm', { models: ['glm-5.3'] }), null, 'not the OpenAI shape');
  assert.equal(parseModelList('glm', null), null);
  assert.equal(parseModelList('glm', 'glm-5.3'), null);
  // Ids that could break a config or an argument are dropped; duplicates (in any case) once.
  assert.deepEqual(parseModelList('glm', { data: [{ id: 'glm-5.3' }, { id: 'GLM-5.3' }, { id: 'glm-5.3 --yolo' }, { id: 'glm-5.3"' }, { id: 7 }, {}] }), ['glm-5.3']);
  assert.equal(parseModelList('glm', { data: Array.from({ length: 200 }, (_, i) => ({ id: `glm-${i}.0` })) }).length, 64, 'at most 64');
  assert.equal(parseModel('glm', 'glm-ocr'), null);
  assert.equal(parseModel('minimax', 'MiniMax-H3'), null);
  assert.deepEqual(parseModel('glm', 'glm-5.3-flash'), { id: 'glm-5.3-flash', version: [5, 3], variants: ['flash'], small: true, stable: true });
});

test('the newest model: highest version, not a Flash for the main slots, the newest Flash for the small one', () => {
  assert.deepEqual(defaultModels('glm', BUNDLED_MODELS.glm), { model: 'glm-5.3', smallModel: 'glm-5.3-flash' });
  assert.deepEqual(defaultModels('minimax', BUNDLED_MODELS.minimax), { model: 'MiniMax-M3', smallModel: 'MiniMax-M3.1-Flash' });
  // A newer model appears: it is the default, with no plugin update.
  assert.deepEqual(defaultModels('glm', ['glm-5.3', 'glm-5.3-flash', 'glm-6', 'glm-6-flash']), { model: 'glm-6', smallModel: 'glm-6-flash' });
  assert.deepEqual(defaultModels('glm', ['glm-5.3', 'glm-5.3-flash', 'glm-6']), { model: 'glm-6', smallModel: 'glm-5.3-flash' });
  assert.deepEqual(defaultModels('minimax', ['MiniMax-M3', 'MiniMax-M3.1-Flash', 'MiniMax-M3.5']), { model: 'MiniMax-M3.5', smallModel: 'MiniMax-M3.1-Flash' });
  // At one version the plain id wins over variants; previews never become the default.
  assert.deepEqual(defaultModels('glm', ['glm-5.3-prime', 'glm-5.3', 'glm-5.3-flashx', 'glm-5.3-flash', 'glm-7-preview']), { model: 'glm-5.3', smallModel: 'glm-5.3-flash' });
  assert.deepEqual(defaultModels('glm', ['glm-4.5', 'glm-4.5-air', 'glm-4.6']), { model: 'glm-4.6', smallModel: 'glm-4.5-air' });
  assert.deepEqual(defaultModels('glm', ['glm-10', 'glm-9.9']), { model: 'glm-10', smallModel: 'glm-10' }, 'numbers, not text; no small model: the main one');
  assert.deepEqual(defaultModels('minimax', ['MiniMax-M3.1-Flash']), { model: 'MiniMax-M3.1-Flash', smallModel: 'MiniMax-M3.1-Flash' }, 'only a Flash: it is both');
  assert.deepEqual(defaultModels('glm', []), { model: 'glm-5.3', smallModel: 'glm-5.3-flash' }, 'an empty list: the bundled one');
  assert.deepEqual(sortModels('glm', ['glm-5.3-flash', 'glm-4.6', 'glm-5.3']), ['glm-5.3', 'glm-5.3-flash', 'glm-4.6']);
  assert.equal(olderThanList('glm', BUNDLED_MODELS.glm, 'glm-4.6'), true);
  assert.equal(olderThanList('glm', BUNDLED_MODELS.glm, 'glm-5.3'), false);
  assert.equal(olderThanList('minimax', BUNDLED_MODELS.minimax, 'MiniMax-M2'), true);
  assert.equal(matchModel(['glm-5.3', 'glm-5.3-flash'], 'flash'), 'glm-5.3-flash');
  assert.equal(matchModel(['glm-5.3', 'glm-5.3-flash'], 'GLM-5.3'), 'glm-5.3');
  // New plan accounts start from the bundled defaults.
  assert.deepEqual([PLAN_INFO.glm.model, PLAN_INFO.glm.smallModel, PLAN_INFO.minimax.model, PLAN_INFO.minimax.smallModel], ['glm-5.3', 'glm-5.3-flash', 'MiniMax-M3', 'MiniMax-M3.1-Flash']);
});

// ---------------------------------------------------------------------------------------------------------------
// The account's own list: host-bound, cached, refreshed daily and on "Read now"
// ---------------------------------------------------------------------------------------------------------------

test('the list is read on the account\'s own host with its key only (OpenAI GET <coding path>/models, no redirects)', async (t) => {
  assert.equal(modelsUrlOf(glm('a')), 'https://api.z.ai/api/coding/paas/v4/models');
  assert.equal(modelsUrlOf({ ...glm('b'), baseUrl: 'https://open.bigmodel.cn/api/anthropic' }), 'https://open.bigmodel.cn/api/coding/paas/v4/models');
  assert.equal(modelsUrlOf(minimax('c')), 'https://api.minimax.io/v1/models');
  assert.equal(modelsUrlOf({ ...minimax('d'), baseUrl: 'https://api.minimax.cn/anthropic' }), 'https://api.minimax.cn/v1/models');
  assert.equal(modelsUrlOf({ ...minimax('e'), preset: 'minimax-openai', baseUrl: 'https://api.minimaxi.com/v1' }), 'https://api.minimaxi.com/v1/models');
  assert.equal(modelsUrlOf({ id: 'x', label: 'X', preset: 'custom-openai', baseUrl: 'https://proxy.example.test/v1', model: 'glm-5.3', agents: ['opencode'] }), null);

  const f = await fixture(t, { answers: async url => url.includes('minimax') ? { body: await fixtureJson('minimax/models-list.json') } : { body: await fixtureJson('zai/models-list.json') } });
  await f.service.save({ version: 1, accounts: [glm('g'), { ...minimax('m'), baseUrl: 'https://api.minimax.cn/anthropic' }] });
  // No key yet: nothing is sent.
  await f.service.models.tick();
  assert.equal(f.calls.length, 0);
  // A key saved for another address is never sent there.
  f.secrets['key.g'] = KEY;
  await f.service.models.tick();
  assert.equal(f.calls.length, 0, 'the key was not bound to this host by the page');
  await f.setKey('g');
  await f.setKey('m');
  await f.settle();
  assert.deepEqual(f.calls.map(call => call.url).sort(), ['https://api.minimax.cn/v1/models', 'https://api.z.ai/api/coding/paas/v4/models']);
  for (const call of f.calls) {
    assert.deepEqual(call.init.headers, { Authorization: `Bearer ${KEY}`, Accept: 'application/json' });
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
  }
  const state = await f.service.state();
  assert.equal(state.models.g.source, 'live');
  assert.deepEqual(state.models.m.models, ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']);
  assert.deepEqual(state.models.m.defaults, { model: 'MiniMax-M3', smallModel: 'MiniMax-M3.1-Flash' });
  // Saved per account with when it was read; no key in the file.
  await f.service.models.flush();
  const file = await readFile(join(f.dataDir, MODELS_FILE), 'utf8');
  const saved = JSON.parse(file);
  assert.deepEqual(Object.keys(saved.accounts).sort(), ['g', 'm']);
  assert.equal(saved.accounts.g.url, 'https://api.z.ai/api/coding/paas/v4/models');
  assert.ok(!file.includes(KEY) && !JSON.stringify(saved).includes(KEY));
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!JSON.stringify(f.logs).includes(KEY));
});

test('cache: read once a day on its own schedule and with "Read now" (not twice within 30 s); kept across restarts', async (t) => {
  let ids = ['glm-5.3', 'glm-5.3-flash'];
  const f = await fixture(t, { answers: () => glmList(ids) });
  await f.service.save({ version: 1, accounts: [glm('g')] });
  await f.setKey('g');
  await f.settle();
  assert.equal(f.calls.length, 1, 'read when the key was saved');
  await f.service.models.tick();
  f.clock.now += 23 * H;
  await f.service.models.tick();
  assert.equal(f.calls.length, 1, 'not again within a day');
  f.clock.now += 1 * H + 1;
  await f.service.models.tick();
  assert.equal(f.calls.length, 2, 'again after 24 h');
  // "Read now" reads the list with the quota, bounded.
  f.clock.now += 60_000;
  await f.service.readQuota('g');
  assert.equal(f.calls.length, 3);
  await f.service.readQuota('g');
  assert.equal(f.calls.length, 3, 'not twice within 30 s');
  // A restart keeps the list and its time: no read until it is due.
  await f.service.models.flush();
  ids = ['glm-6', 'glm-6-flash'];
  const again = f.make(f.storage.accounts);
  assert.deepEqual(again.modelList(again.settings.accounts[0]).models, ['glm-5.3', 'glm-5.3-flash']);
  await again.models.tick();
  assert.equal(f.calls.length, 3);
});

test('fallback: no network, a 404, a list without coding models or a failed read use the bundled list (or keep the last good one)', async (t) => {
  // A service without a network (a test, a script) never sends anything and uses the bundled list.
  const offline = await fixture(t, { network: false });
  await offline.service.save({ version: 1, accounts: [glm('g')] });
  await offline.setKey('g');
  await offline.service.readQuota('g').catch(() => undefined);
  await offline.service.models.tick();
  assert.equal(offline.calls.length, 0);
  assert.equal((await offline.service.state()).models.g.source, 'bundled');

  let answer = { status: 404, body: { error: 'not found' } };
  const f = await fixture(t, { answers: () => answer });
  await f.service.save({ version: 1, accounts: [glm('g')] });
  await f.setKey('g');
  await f.settle();
  let list = (await f.service.state()).models.g;
  assert.equal(list.source, 'bundled');
  assert.deepEqual(list.models, ['glm-5.3', 'glm-5.3-flash']);
  assert.match(list.note, /no model list/);
  f.clock.now += 2 * H;
  await f.service.models.tick();
  assert.equal(f.calls.length, 1, 'a host without a list is asked again only the next day');
  f.clock.now += 23 * H;
  answer = { body: { data: [{ id: 'glm-4.6v' }, { id: 'embedding-3' }] } };
  await f.service.models.tick();
  assert.match((await f.service.state()).models.g.note, /no coding model/);
  f.clock.now += 25 * H;
  answer = glmList(['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  await f.service.models.tick();
  assert.equal((await f.service.state()).models.g.source, 'live');
  // A failed read later keeps the account's last good list, says why, and is tried again within the hour.
  f.clock.now += 25 * H;
  answer = { status: 500, body: 'boom' };
  await f.service.models.tick();
  list = (await f.service.state()).models.g;
  assert.equal(list.source, 'live');
  assert.deepEqual(list.models, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  assert.match(list.note, /HTTP 500/);
  const calls = f.calls.length;
  f.clock.now += H;
  await f.service.models.tick();
  assert.equal(f.calls.length, calls + 1);
  // A refused key and an unreachable host are said without the key, even when the error carries it.
  f.clock.now += H;
  answer = new Error(`connect ECONNREFUSED for ${KEY}`);
  await f.service.models.tick();
  f.clock.now += H;
  answer = { status: 401, body: { error: KEY } };
  await f.service.models.tick();
  const state = await f.service.state();
  assert.match(state.models.g.note, /refused the key \(401\)/);
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(!JSON.stringify(f.logs).includes(KEY));
  await f.service.models.flush();
  assert.ok(!(await readFile(join(f.dataDir, MODELS_FILE), 'utf8')).includes(KEY));
});

// ---------------------------------------------------------------------------------------------------------------
// Following the list: old accounts, newer models, the person's own choice
// ---------------------------------------------------------------------------------------------------------------

test('migration: plan accounts saved with old models move to the newest ones, said once; a model the person chose stays', async (t) => {
  const saved = { settings: { version: 1, accounts: [
    { id: 'glm-old', label: 'GLM old', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
    { id: 'mm-old', label: 'MiniMax old', preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', agents: ['claude'] },
    { id: 'mm-plan', label: 'MiniMax plan', preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.cn/anthropic', model: 'MiniMax-M3.1-Flash', agents: ['claude', 'opencode'], trust: 'D1' },
    { id: 'glm-kept', label: 'GLM kept', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.5', agents: ['claude'], modelPinned: true },
    { id: 'or', label: 'OR', preset: 'openrouter-openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6', agents: ['opencode'] }
  ] }, keyOrigins: {} };
  const f = await fixture(t, { saved, network: false });
  const byId = id => f.service.settings.accounts.find(account => account.id === id);
  assert.deepEqual([byId('glm-old').model, byId('glm-old').smallModel], ['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual([byId('mm-old').model, byId('mm-old').smallModel], ['MiniMax-M3', 'MiniMax-M3.1-Flash']);
  assert.deepEqual([byId('mm-plan').model, byId('mm-plan').smallModel], ['MiniMax-M3', 'MiniMax-M3.1-Flash'], 'the earlier plan default is not a choice');
  assert.deepEqual([byId('glm-kept').model, byId('glm-kept').smallModel], ['glm-4.5', 'glm-5.3-flash'], 'the chosen model stays; its small slot follows');
  assert.equal(byId('or').model, 'z-ai/glm-4.6', 'not a plan account: untouched');
  // Written by load(), with one notice per account moved.
  assert.deepEqual(f.storage.accounts.settings.accounts.find(account => account.id === 'glm-old').model, 'glm-5.3');
  const notices = (await f.service.state()).modelNotices;
  assert.deepEqual(notices.map(notice => [notice.accountId, notice.from.model, notice.to.model, notice.reason]), [
    ['glm-old', 'glm-4.6', 'glm-5.3', 'older'], ['mm-old', 'MiniMax-M2', 'MiniMax-M3', 'older'], ['mm-plan', 'MiniMax-M3.1-Flash', 'MiniMax-M3', 'newer'], ['glm-kept', 'glm-4.5', 'glm-4.5', 'older']
  ]);
  // A restart does not say it again; «OK» clears it for good.
  const restarted = f.make(f.storage.accounts);
  await restarted.load();
  assert.equal((await restarted.state()).modelNotices.length, 4, 'shown until dismissed, not repeated');
  await restarted.modelNoticesSeen();
  assert.deepEqual(f.storage.accounts.modelNotices, []);
  const third = f.make(f.storage.accounts);
  await third.load();
  assert.deepEqual((await third.state()).modelNotices, []);
  // A page with an older view cannot put an unchosen slot back on the old model.
  await third.save({ version: 1, accounts: third.settings.accounts.map(account => account.id === 'glm-old' ? { ...account, model: 'glm-4.6' } : account) });
  assert.equal(third.settings.accounts.find(account => account.id === 'glm-old').model, 'glm-5.3');
  // Choosing on the page pins it; "newest" unpins it.
  await third.save({ version: 1, accounts: third.settings.accounts.map(account => account.id === 'glm-old' ? { ...account, model: 'glm-5.3-flash', modelPinned: true } : account) });
  assert.deepEqual([third.settings.accounts[0].model, third.settings.accounts[0].modelPinned], ['glm-5.3-flash', true]);
  const { modelPinned: _pinned, ...unpinned } = third.settings.accounts[0];
  await third.save({ version: 1, accounts: [unpinned, ...third.settings.accounts.slice(1)] });
  assert.equal(third.settings.accounts[0].model, 'glm-5.3');
  // Pins belong to plan accounts only: refused by validation, dropped by the service for an account not on a plan's host.
  const other = { id: 'x', label: 'X', preset: 'custom-openai', baseUrl: 'https://proxy.example.test/v1', model: 'm', agents: ['opencode'], modelPinned: true };
  assert.throws(() => validateAccount(other), /coding-plan account/);
  assert.throws(() => validateAccount({ ...glm('p'), modelPinned: 'yes' }), /true or false/);
  await third.save({ version: 1, accounts: [...third.settings.accounts, other] });
  assert.equal(third.settings.accounts.at(-1).modelPinned, undefined);
  await third.save({ version: 1, accounts: third.settings.accounts.slice(0, -1) });
  // Moving a plan account off the plan's host drops its plan slots instead of refusing.
  await third.save({ version: 1, accounts: third.settings.accounts.map(account => account.id === 'mm-old' ? { ...account, preset: 'custom-anthropic', baseUrl: 'https://proxy.example.test/anthropic' } : account) });
  const moved = third.settings.accounts.find(account => account.id === 'mm-old');
  assert.deepEqual([moved.model, moved.smallModel], ['MiniMax-M3', undefined]);
});

test('a newer model on the account\'s list: accounts that follow the list take it at once (with a notice), chosen ones do not', async (t) => {
  let ids = ['glm-5.3', 'glm-5.3-flash'];
  const f = await fixture(t, { answers: () => glmList(ids) });
  await f.service.save({ version: 1, accounts: [glm('auto'), glm('mine', { model: 'glm-5.3', modelPinned: true })] });
  await f.setKey('auto');
  await f.setKey('mine');
  await f.settle();
  assert.deepEqual((await f.service.state()).modelNotices, []);
  ids = ['glm-6', 'glm-6-flash', 'glm-5.3', 'glm-5.3-flash'];
  f.clock.now += 25 * H;
  await f.service.models.tick();
  await f.settle();
  const [auto, mine] = f.service.settings.accounts;
  assert.deepEqual([auto.model, auto.smallModel], ['glm-6', 'glm-6-flash']);
  assert.deepEqual([mine.model, mine.smallModel], ['glm-5.3', 'glm-6-flash']);
  assert.deepEqual(f.storage.accounts.settings.accounts.map(account => account.model), ['glm-6', 'glm-5.3'], 'saved');
  assert.deepEqual((await f.service.state()).modelNotices.map(notice => [notice.accountId, notice.to.model, notice.reason]), [['auto', 'glm-6', 'newer'], ['mine', 'glm-5.3', 'newer']]);
  // The launch runs it: Claude Code's main slots and Haiku, OpenCode with the whole list.
  const claude = await f.service.prepare(f.context({ options: { account: 'auto' } }));
  assert.deepEqual([claude.env.ANTHROPIC_MODEL, claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, claude.env.CLAUDE_CODE_SUBAGENT_MODEL], ['glm-6', 'glm-6', 'glm-6-flash', 'glm-6']);
  const oc = JSON.parse((await f.service.prepare(f.context({ sessionId: 's2', provider: 'opencode', options: { account: 'auto' } }))).files[0].content);
  const provider = Object.keys(oc.provider)[0];
  assert.deepEqual(Object.keys(oc.provider[provider].models), ['glm-6', 'glm-6-flash', 'glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual([oc.model, oc.small_model], [`${provider}/glm-6`, `${provider}/glm-6-flash`]);
});

// ---------------------------------------------------------------------------------------------------------------
// The launcher, routes, shares, broker
// ---------------------------------------------------------------------------------------------------------------

test('the launcher\'s Model lists the plans\' models; a launch on pool:glm or an account runs the chosen one if its list has it', async (t) => {
  const f = await fixture(t, { answers: url => url.includes('minimax') ? glmList([]) : glmList(['glm-5.3', 'glm-5.3-flash', 'glm-5.2']) });
  await f.service.save({ version: 1, accounts: [glm('g'), minimax('m'), { id: 'local', label: 'Local', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude'] }] });
  await f.setKey('g');
  await f.setKey('m');
  await f.settle();
  assert.deepEqual(f.service.launchOptions('claude').model.map(option => option.value), ['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'MiniMax-M3.1-Flash', 'MiniMax-M3']);
  assert.equal(f.service.launchOptions('claude').model[0].label, 'GLM Coding Plan · glm-5.3');
  assert.equal(f.service.launchOptions('codex').model, undefined, 'plans run Claude Code and OpenCode');
  const flash = await f.service.prepare(f.context({ options: { account: 'pool:glm', model: 'glm-5.3-flash' } }));
  assert.deepEqual([flash.env.ANTHROPIC_MODEL, flash.env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['glm-5.3-flash', 'glm-5.3-flash']);
  const older = await f.service.prepare(f.context({ sessionId: 's2', options: { account: 'g', model: 'GLM-5.2' } }));
  assert.deepEqual([older.env.ANTHROPIC_MODEL, older.env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['glm-5.2', 'glm-5.3-flash'], 'the list\'s spelling; the small slot stays');
  const plain = await f.service.prepare(f.context({ sessionId: 's3', options: { account: 'g', model: 'default' } }));
  assert.equal(plain.env.ANTHROPIC_MODEL, 'glm-5.3');
  assert.match((await f.service.prepare(f.context({ sessionId: 's4', options: { account: 'pool:glm', model: 'MiniMax-M3' } }))).refuse.reason, /No GLM Coding Plan account lists the model MiniMax-M3/);
  assert.match((await f.service.prepare(f.context({ sessionId: 's5', options: { account: 'm', model: 'glm-5.3' } }))).refuse.reason, /does not list the model glm-5\.3/);
  assert.match((await f.service.prepare(f.context({ sessionId: 's6', options: { account: 'local', model: 'glm-5.3' } }))).refuse.reason, /for GLM and MiniMax Coding Plan accounts/);
  assert.match((await f.service.prepare(f.context({ sessionId: 's7', options: { account: 'none', model: 'glm-5.3' } }))).refuse.reason, /for GLM and MiniMax Coding Plan accounts/);
});

test('routes, pick_account, shares and broker offers carry each plan account\'s list; a model filter matches the list', async (t) => {
  const f = await fixture(t, { answers: () => glmList(['glm-5.3', 'glm-5.3-flash', 'glm-5.2']) });
  await f.service.save({ version: 1, accounts: [glm('g', { brokerable: true })] });
  await f.setKey('g');
  await f.settle();
  const routes = (await f.service.tool('list_routes', { provider: 'claude' })).content.routes;
  const row = routes.find(entry => entry.accountId === 'g');
  assert.deepEqual([row.model, row.smallModel, row.models], ['glm-5.3', 'glm-5.3-flash', ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']]);
  assert.deepEqual(row.launchOptions, { 'canvastty-accounts': { account: 'g', effort: 'default', trustFolder: false } });
  const filtered = (await f.service.tool('list_routes', { provider: 'claude', model: '5.2' })).content.routes.find(entry => entry.accountId === 'g');
  assert.equal(filtered.model, 'glm-5.2');
  assert.deepEqual(filtered.launchOptions, { 'canvastty-accounts': { account: 'g', effort: 'default', trustFolder: false, model: 'glm-5.2' } });
  const pick = (await f.service.tool('pick_account', { provider: 'claude', model: 'flash' })).content;
  assert.equal(pick.model, 'glm-5.3-flash');
  assert.deepEqual(pick.spawn.launchOptions, { 'canvastty-accounts': { account: 'g', effort: 'default', trustFolder: false, model: 'glm-5.3-flash' } });
  assert.deepEqual(pick.models, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  const shared = await f.service.shareRead({ caller: { pluginId: 'canvastty-assistant' }, method: 'accounts.routes', params: { provider: 'claude' } });
  assert.deepEqual(shared.routes.find(entry => entry.accountId === 'g').models, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  assert.deepEqual(shared.plans[0].models, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  const quota = await f.service.shareRead({ caller: { pluginId: 'canvastty-assistant' }, method: 'accounts.quota', params: {} });
  assert.deepEqual([quota.accounts[0].model, quota.accounts[0].smallModel, quota.accounts[0].modelsFrom], ['glm-5.3', 'glm-5.3-flash', 'live']);
  assert.deepEqual(f.service.brokerOffer()[0].models, ['glm-5.3', 'glm-5.3-flash', 'glm-5.2']);
  assert.deepEqual(f.service.brokerAdmit({ ref: 'g', caller: { pluginId: 'canvastty-assistant' }, model: 'glm-5.2' }), { ok: true });
  assert.ok(!JSON.stringify([routes, pick, shared, quota, f.service.brokerOffer()]).includes(KEY));
});

// Quick add for coding plans (provider + key → done) against a fake host (storage, secrets) and a fake network that
// answers with hand-written fixtures: the region found by the plan's own quota read (international host first, the
// China host only after a refused key), nothing saved when no host takes the key, never a model request, the defaults
// (label, cards at once, for Auto, the data class asked once and remembered, not asked when data classes are off), and
// the key kept on the host it was found on until the person moves the account. Every key is assembled at runtime.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService, probeSecretKey } from '../src/service/accounts.ts';
import { probePlanRegion, PROBE_PATHS } from '../src/plans/probe.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const H = 3_600_000;
const KEY = ['plan', 'quick', 'fixture', 'c0de'.repeat(6)].join('.');
const PAYG = ['sk', 'api', 'fixture', 'feed'.repeat(5)].join('-');
const fixtureJson = async (dir, name) => JSON.parse(await readFile(new URL(`./fixtures/${dir}/${name}`, import.meta.url), 'utf8'));
const zaiUsed = percent => ({ code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: percent, nextResetTime: NOW + 2 * H }], level: 'pro' } });
const QUOTA_PATHS = new Set(Object.values(PROBE_PATHS));

/** `answers(url)` → { status, body } | Error; every request (quota reader, model lists, probe) is recorded. */
async function fixture(t, { answers = () => ({ status: 401, body: {} }), storage: savedStorage } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-quick-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = savedStorage ?? {};
  const secrets = {};
  const logs = [];
  const calls = [];
  const clock = { now: NOW };
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return structuredClone(storage[params.key] ?? null);
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      if (method === 'sessions.subscribe') return { sessions: [] };
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: () => undefined
  };
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    const next = await answers(url, init);
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
  };
  const make = () => new AccountsService({ host, dataDir, saved: storage.accounts, quotaFetch: fetch, modelsFetch: fetch, now: () => clock.now, random: () => 0.5 });
  const service = make();
  await service.pools.start();
  t.after(() => service.pools.stop());
  /** What the page does: stage the key, ask, then write the key for the new account and bind it. */
  const quickAdd = async (params, key = KEY) => {
    secrets[probeSecretKey(params.provider)] = key;
    const result = await service.planQuickAdd(params);
    if (result.added) { secrets[`key.${result.id}`] = key; await service.keyChanged(result.id); }
    delete secrets[probeSecretKey(params.provider)];
    return result;
  };
  return { service, storage, secrets, logs, calls, clock, host, quickAdd, make };
}

/** No request ever reached a model endpoint: every one is a GET of a quota read or a model list, never followed. */
function assertNoGeneration(calls) {
  for (const call of calls) {
    const path = new URL(call.url).pathname;
    assert.equal(call.method, 'GET', call.url);
    assert.equal(call.redirect, 'error', call.url);
    assert.doesNotMatch(path, /messages|chat|completions|responses|generate|anthropic\/v1/u, call.url);
    assert.ok(QUOTA_PATHS.has(path) || /\/models$/u.test(path), `unexpected request ${call.url}`);
  }
}
const probeCalls = calls => calls.filter(call => QUOTA_PATHS.has(new URL(call.url).pathname));

test('region: the international host answers → saved there, with the first quota reading; China is never asked', async (t) => {
  const f = await fixture(t, { answers: url => url.startsWith('https://api.z.ai/api/monitor/') ? { body: zaiUsed(30) } : { status: 404, body: {} } });
  await f.service.setDefaults({ dataClass: 'D1' });
  const result = await f.quickAdd({ provider: 'glm' });
  assert.equal(result.added, true);
  assert.equal(result.region, 'intl');
  assert.equal(result.host, 'api.z.ai');
  assert.deepEqual(probeCalls(f.calls).map(call => call.url), ['https://api.z.ai/api/monitor/usage/quota/limit']);
  const account = f.service.settings.accounts.find(entry => entry.id === result.id);
  assert.equal(new URL(account.baseUrl).host, 'api.z.ai');
  // The probe's reading is the account's first read (the key bound since is the probed one).
  const state = await f.service.state();
  assert.equal(state.keys[result.id], 'ok');
  assert.equal(state.quota[result.id].remainingPercent, 70);
  assert.equal(state.plans.accounts[result.id].region, 'intl');
  assertNoGeneration(f.calls);
  assert.ok(!JSON.stringify(f.logs).includes(KEY) && !JSON.stringify(f.storage).includes(KEY), 'the key is never logged or stored');
});

test('region: the international host refuses the key (401) → the China host answers → saved on the China host', async (t) => {
  const f = await fixture(t, { answers: url => url.startsWith('https://open.bigmodel.cn/') ? { body: zaiUsed(10) } : { status: 401, body: { error: { code: '401' } } } });
  await f.service.setDefaults({ dataClass: 'D2' });
  const result = await f.quickAdd({ provider: 'glm' });
  assert.equal(result.added, true);
  assert.equal(result.region, 'cn');
  assert.equal(result.host, 'open.bigmodel.cn');
  assert.deepEqual(probeCalls(f.calls).map(call => new URL(call.url).host), ['api.z.ai', 'open.bigmodel.cn']);
  const account = f.service.settings.accounts.find(entry => entry.id === result.id);
  assert.equal(new URL(account.baseUrl).host, 'open.bigmodel.cn');
  assert.equal((await f.service.state()).keys[result.id], 'ok');
  assertNoGeneration(f.calls);
});

test('region: MiniMax — a 403 or the plan\'s own "invalid key" code counts as refused; 200 on minimax.cn is the China region', async (t) => {
  const auth = await fixtureJson('minimax', 'remains-auth.json');
  const current = await fixtureJson('minimax', 'remains-current.json');
  const f = await fixture(t, { answers: url => url.startsWith('https://api.minimax.cn/') ? { body: current } : { status: 200, body: auth } });
  await f.service.setDefaults({ dataClass: 'D0' });
  const result = await f.quickAdd({ provider: 'minimax' });
  assert.equal(result.added, true);
  assert.equal(result.region, 'cn');
  assert.equal(result.host, 'api.minimax.cn');
  assert.deepEqual(probeCalls(f.calls).map(call => call.url), ['https://api.minimax.io/v1/token_plan/remains', 'https://api.minimax.cn/v1/token_plan/remains']);
  const forbidden = await probePlanRegion({ provider: 'minimax', key: KEY, now: () => NOW,
    fetch: async url => ({ status: url.includes('minimax.io') ? 403 : 200, text: async () => JSON.stringify(current) }) });
  assert.equal(forbidden.ok, true);
  assert.equal(forbidden.region, 'cn');
  assertNoGeneration(f.calls);
});

test('region: both hosts refuse the key → a clear error naming both, nothing saved', async (t) => {
  const authFailed = await fixtureJson('zai', 'quota-auth-failed.json');
  const f = await fixture(t, { answers: url => url.includes('bigmodel') ? { status: 200, body: authFailed } : { status: 401, body: {} } });
  await f.service.setDefaults({ dataClass: 'D1' });
  const before = structuredClone(f.storage.accounts ?? null);
  const result = await f.quickAdd({ provider: 'glm' });
  assert.equal(result.added, false);
  assert.equal(result.reason, 'key-refused');
  assert.deepEqual(result.tried.map(entry => [entry.host, entry.outcome]), [['api.z.ai', 'refused-key'], ['open.bigmodel.cn', 'refused-key']]);
  assert.match(result.message, /api\.z\.ai and open\.bigmodel\.cn.*nothing was saved/u);
  assert.equal(f.service.settings.accounts.length, 0);
  assert.deepEqual(f.storage.accounts ?? null, before, 'the accounts were not written');
  assert.ok(!JSON.stringify(result).includes(KEY));
  assertNoGeneration(f.calls);
});

test('region: an international host that does not answer stops the probe (the key is not sent to China), nothing saved', async (t) => {
  for (const answer of [new Error('ECONNREFUSED'), { status: 502, body: 'bad gateway' }]) {
    const f = await fixture(t, { answers: () => answer });
    await f.service.setDefaults({ dataClass: 'D1' });
    const result = await f.quickAdd({ provider: 'glm' });
    assert.equal(result.added, false);
    assert.equal(result.reason, 'unreachable');
    assert.deepEqual(probeCalls(f.calls).map(call => new URL(call.url).host), ['api.z.ai']);
    assert.equal(f.service.settings.accounts.length, 0);
  }
});

test('region: a region chosen under «Дополнительно» asks only that host; a MiniMax pay-as-you-go key is never sent', async (t) => {
  const f = await fixture(t, { answers: () => ({ body: zaiUsed(5) }) });
  await f.service.setDefaults({ dataClass: 'D1' });
  const chosen = await f.quickAdd({ provider: 'glm', region: 'cn' });
  assert.equal(chosen.added, true);
  assert.deepEqual(probeCalls(f.calls).map(call => new URL(call.url).host), ['open.bigmodel.cn']);
  const before = f.calls.length;
  const payg = await f.quickAdd({ provider: 'minimax' }, PAYG);
  assert.equal(payg.added, false);
  assert.equal(payg.reason, 'pay-as-you-go');
  assert.equal(f.calls.length, before, 'nothing was sent');
});

test('defaults: label «GLM n» (first free number), 2 cards at once, for Auto on, the data class default; Advanced overrides', async (t) => {
  const f = await fixture(t, { answers: () => ({ body: zaiUsed(20) }) });
  await f.service.setDefaults({ dataClass: 'D2' });
  const first = await f.quickAdd({ provider: 'glm' });
  const second = await f.quickAdd({ provider: 'glm' });
  assert.deepEqual([first.label, second.label], ['GLM 1', 'GLM 2']);
  const saved = f.service.settings.accounts.find(entry => entry.id === first.id);
  assert.equal(saved.trust, 'D2');
  assert.equal(saved.concurrency ?? 2, 2);
  assert.equal(saved.brokerable, true);
  assert.equal(first.forAuto, true);
  assert.equal(first.autoSeen, false, 'the Assistant never read these accounts: the page shows the one-line note');
  // Numbers go on after the count of the plan's accounts, skipping one that is taken («GLM 2» after «GLM 1» was removed).
  await f.service.save({ version: 1, accounts: f.service.settings.accounts.filter(entry => entry.id !== first.id) });
  assert.equal((await f.quickAdd({ provider: 'glm' })).label, 'GLM 3');
  const custom = await f.quickAdd({ provider: 'glm', label: 'Work', concurrency: 5, brokerable: false, trust: 'D0' });
  const account = f.service.settings.accounts.find(entry => entry.id === custom.id);
  assert.deepEqual([account.label, account.concurrency, account.brokerable === true, account.trust], ['Work', 5, false, 'D0']);
  assert.equal((await f.quickAdd({ provider: 'minimax' })).label, 'MiniMax 1');
});

test('defaults: the data class is asked once — no answer, no request; the answer is remembered across restarts', async (t) => {
  const f = await fixture(t, { answers: () => ({ body: zaiUsed(20) }) });
  assert.equal((await f.service.state()).defaults.dataClass, null);
  const asked = await f.quickAdd({ provider: 'glm' });
  assert.equal(asked.added, false);
  assert.equal(asked.reason, 'trust-needed');
  assert.equal(f.calls.length, 0, 'nothing is sent before the person answered');
  await f.service.setDefaults({ dataClass: 'D3' });
  await assert.rejects(f.service.setDefaults({ dataClass: 'unset' }), /D0, D1, D2 or D3/u);
  const added = await f.quickAdd({ provider: 'glm' });
  assert.equal(added.trust, 'D3');
  assert.equal(f.storage.defaults.dataClass, 'D3');
  // A new service (CanvasTTY restarted) reads the answer: not asked again.
  const again = f.make();
  assert.equal((await again.state()).defaults.dataClass, 'D3');
});

test('defaults: the Assistant reading these accounts marks Auto set up; its data-check mode Off means the class is not asked', async (t) => {
  const f = await fixture(t, { answers: () => ({ body: zaiUsed(20) }) });
  // Another plugin's read changes nothing.
  await f.service.shareRead({ caller: { pluginId: 'someone-else' }, method: 'accounts.quota', params: { dataClassMode: 'off' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.state()).defaults.autoSeenAt, null);
  await f.service.shareRead({ caller: { pluginId: 'canvastty-assistant' }, method: 'accounts.quota', params: { dataClassMode: 'off' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const { defaults } = await f.service.state();
  assert.equal(defaults.autoSeenAt, NOW);
  assert.equal(defaults.dataClassMode, 'off');
  const result = await f.quickAdd({ provider: 'glm' });
  assert.equal(result.added, true);
  assert.equal(result.trust, 'unset');
  assert.equal(result.autoSeen, true);
});

test('binding: the key stays on the host it was found on; only the person\'s «move» re-binds it', async (t) => {
  let refuse = false;
  const f = await fixture(t, { answers: url => refuse ? { status: 401, body: {} } : url.includes('api.z.ai') ? { body: zaiUsed(20) } : { status: 401, body: {} } });
  await f.service.setDefaults({ dataClass: 'D1' });
  const result = await f.quickAdd({ provider: 'glm' });
  const account = () => f.service.settings.accounts.find(entry => entry.id === result.id);
  // A later refusal on a quota read never moves the account or its key.
  refuse = true;
  f.clock.now += 2 * H;
  await f.service.readQuota(result.id);
  assert.equal(new URL(account().baseUrl).host, 'api.z.ai');
  assert.equal((await f.service.state()).keys[result.id], 'ok');
  const before = f.calls.length;
  // The person's move: the account and its key go to the China host, with nothing sent on the way.
  assert.deepEqual(await f.service.planRegion({ accountId: result.id, region: 'cn' }), { region: 'cn', host: 'open.bigmodel.cn' });
  assert.equal(f.calls.length, before);
  assert.equal(new URL(account().baseUrl).host, 'open.bigmodel.cn');
  assert.equal(new URL(account().baseUrl).pathname, '/api/anthropic');
  assert.equal((await f.service.state()).keys[result.id], 'ok');
  // Any other change of the address (an edited account) is not a move: the key must be saved again.
  await f.service.save({ version: 1, accounts: f.service.settings.accounts.map(entry => entry.id === result.id ? { ...entry, baseUrl: 'https://api.z.ai/api/anthropic' } : entry) });
  assert.equal((await f.service.state()).keys[result.id], 'other-address');
  await assert.rejects(f.service.planRegion({ accountId: 'nope', region: 'cn' }), /No such plan account/u);
});

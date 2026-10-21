// Account quotas: the Z.AI quota and limit-error shapes (fixtures), the quota record (exhaustion, early and predicted
// resets, staleness), the read schedule, and the reader inside the service with a fake network: only the account's
// own host is contacted, the key never leaves the request, state survives a restart, and routes skip a used-up account.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseZaiQuota, parseZaiLimitError, parseFlushTime, ZaiQuotaError } from '../src/quota/zai.ts';
import { emptyRecord, observe, viewOf, nextReadAt, readFailed, used, SCHEDULE, STALE_MS, ERROR_GRACE_MS } from '../src/quota/model.ts';
import { QuotaReader, quotaUrlOf, MAX_READS_PER_HOUR } from '../src/quota/reader.ts';
import { AccountsService } from '../src/service/accounts.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const H = 3_600_000;
const MIN = 60_000;
const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/zai/${name}`, import.meta.url), 'utf8'));
const fixtureText = name => readFile(new URL(`./fixtures/zai/${name}`, import.meta.url), 'utf8');
// Assembled at runtime: no key-shaped literal in the repository.
const KEY = ['zai', 'fixture', 'b16b00b5'.repeat(4)].join('.');

// ---------------------------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------------------------

test('Z.AI quota: Lite (5h + MCP), Pro (5h + weekly + MCP, counts win over percentage), credits', async () => {
  const lite = parseZaiQuota(await fixture('quota-lite.json'), NOW);
  assert.deepEqual(lite.windows.map(w => [w.id, w.label, w.usedPercent, w.resetsAt, w.models]), [
    ['zai:tokens:300', '5h', 42, NOW + 2 * H, true],
    ['zai:tools', 'MCP month', 7, NOW + 240 * H, false]
  ]);
  assert.equal(lite.plan, 'lite');
  const pro = parseZaiQuota(await fixture('quota-pro.json'), NOW);
  assert.deepEqual(pro.windows.map(w => [w.id, w.usedPercent, w.windowMinutes]), [['zai:tokens:300', 31.3, 300], ['zai:tokens:10080', 64, 10_080], ['zai:tools', 12.3, 43_200]]);
  assert.equal(pro.windows[0].used, 12_500_000);
  assert.equal(pro.windows[0].limit, 40_000_000);
  assert.equal(pro.plan, 'GLM Coding Pro');
  const credits = parseZaiQuota(await fixture('quota-credits.json'), NOW);
  assert.deepEqual(credits.windows.map(w => [w.id, w.usedPercent]), [['zai:credits:300', 25]]);
});

test('Z.AI quota: a 5h reset ten hours away is dropped (no time-zone guess); unknown shapes are errors, never 0 %', async () => {
  const odd = parseZaiQuota(await fixture('quota-implausible-reset.json'), NOW);
  assert.equal(odd.windows[0].resetsAt, null);
  assert.equal(odd.windows[0].usedPercent, 20);
  const empty = await fixture('quota-empty.json');
  assert.throws(() => parseZaiQuota(empty, NOW), ZaiQuotaError);
  assert.throws(() => parseZaiQuota({ code: 200, data: { limits: [{ type: 'SOMETHING_NEW', percentage: 0 }] } }, NOW), /no model windows/u);
  await assert.rejects(async () => parseZaiQuota(await fixture('quota-auth-failed.json'), NOW), error => error.kind === 'auth');
});

test('Z.AI limit errors: 1308/1310/1316 give a reset time, 1302 is not a quota, 1309 blocks without a time', async () => {
  const e1308 = parseZaiLimitError(await fixture('error-1308.json'), NOW);
  // "2026-10-21 14:00:00" without a zone: 14:00 UTC fits the 5 h window, 06:00 UTC (UTC+8 reading) is past.
  assert.deepEqual(e1308, { code: '1308', kind: 'exhausted', until: Date.UTC(2026, 9, 21, 14), zoneGuessed: true, windowMinutes: 300 });
  const e1310 = parseZaiLimitError(await fixture('error-1310.json'), NOW);
  assert.equal(e1310.until, Date.UTC(2026, 9, 24, 12));
  assert.equal(e1310.zoneGuessed, false);
  // 21:30 UTC is beyond a 5 h window, so the UTC+8 reading (13:30 UTC) is the one.
  assert.equal(parseZaiLimitError(await fixture('error-1316.json'), NOW).until, Date.UTC(2026, 9, 21, 13, 30));
  assert.equal(parseZaiLimitError(await fixture('error-1302.json'), NOW), null);
  assert.deepEqual(parseZaiLimitError(await fixture('error-1309.json'), NOW), { code: '1309', kind: 'blocked', until: null, zoneGuessed: false, windowMinutes: 300 });
  // An agent's printed error (text, not JSON).
  const text = 'API Error: 429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-21 14:00:00"}}';
  assert.equal(parseZaiLimitError(text, NOW).code, '1308');
  assert.equal(parseZaiLimitError('all good, 1308 lines changed', NOW), null);
  assert.equal(parseZaiLimitError('Error 1308: Usage limit reached for 5 hour. Your limit will reset at 2026-10-21 14:00:00', NOW).until, Date.UTC(2026, 9, 21, 14));
  assert.equal(parseFlushTime('reset at 1792591200', NOW, 300).at, NOW + 2 * H);
  assert.equal(parseFlushTime('no time here', NOW, 300), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------------------------

const window = (id, usedPercent, resetsAt, extra = {}) => ({ id, label: id.includes('10080') ? '7d' : '5h', usedPercent, used: null, limit: null, windowMinutes: id.includes('10080') ? 10_080 : 300, resetsAt, models: true, ...extra });
const read = (windows, at) => ({ source: 'zai-quota-api', at, windows });

test('exhaustion → predicted reset passes (probably reset) → read shows room (reset as predicted)', () => {
  let { record, events } = observe(emptyRecord(), read([window('zai:tokens:300', 100, NOW + 2 * H)], NOW), NOW);
  assert.deepEqual(events.map(e => e.kind), ['exhausted']);
  assert.equal(record.exhaustedUntil, NOW + 2 * H);
  assert.equal(viewOf(record, NOW + H).state, 'exhausted');
  const later = NOW + 2 * H + 10_000;
  assert.equal(viewOf(record, later).state, 'presumed-reset');
  ({ record, events } = observe(record, read([window('zai:tokens:300', 2, NOW + 7 * H)], later), later));
  assert.deepEqual(events.map(e => e.kind), ['reset']);
  assert.equal(viewOf(record, later).state, 'ok');
});

test('an early reset (room again before the predicted reset) clears the exhaustion at once and is logged', () => {
  let { record } = observe(emptyRecord(), read([window('zai:tokens:300', 100, NOW + 2 * H)], NOW), NOW);
  const at = NOW + 30 * MIN;
  const result = observe(record, read([window('zai:tokens:300', 0, null)], at), at);
  assert.deepEqual(result.events.map(e => e.kind), ['early-reset']);
  assert.match(result.events[0].note, /5h: 100% → 0% before/u);
  assert.equal(result.record.exhaustedUntil, null);
  assert.equal(viewOf(result.record, at).state, 'ok');
  // Without an exhaustion: a usage drop with the window moved is still an early reset; slow rolling decay is not.
  ({ record } = observe(emptyRecord(), read([window('zai:tokens:10080', 64, NOW + 72 * H)], NOW), NOW));
  assert.deepEqual(observe(record, read([window('zai:tokens:10080', 0, NOW + 168 * H)], at), at).events.map(e => e.kind), ['early-reset']);
  assert.deepEqual(observe(record, read([window('zai:tokens:10080', 58, NOW + 72 * H)], at), at).events, []);
});

test('a limit error exhausts; a read right after it does not clear it, a later read with room does (early reset)', () => {
  let { record, events } = observe(emptyRecord(), { source: 'zai-limit-error', at: NOW, windows: [], exhausted: { until: NOW + 2 * H, code: '1308' } }, NOW);
  assert.deepEqual(events.map(e => e.kind), ['exhausted']);
  const soon = NOW + ERROR_GRACE_MS / 2;
  ({ record, events } = observe(record, read([window('zai:tokens:300', 97, NOW + 2 * H)], soon), soon));
  assert.equal(viewOf(record, soon).state, 'exhausted');
  const later = NOW + 20 * MIN;
  ({ record, events } = observe(record, read([window('zai:tokens:300', 3, NOW + 5 * H)], later), later));
  assert.deepEqual(events.map(e => e.kind), ['early-reset']);
  assert.equal(viewOf(record, later).state, 'ok');
});

test('unknown is never used up: no read, an old read, an old open exhaustion', () => {
  assert.equal(viewOf(emptyRecord(), NOW).state, 'unknown');
  const { record } = observe(emptyRecord(), read([window('zai:tokens:300', 95, NOW + 4 * H)], NOW), NOW);
  assert.equal(viewOf(record, NOW).state, 'low');
  const old = viewOf(record, NOW + STALE_MS + MIN);
  assert.equal(old.state, 'stale');
  assert.equal(old.remainingPercent, null);
  assert.equal(old.ageMinutes, 31);
  const open = observe(emptyRecord(), { source: 'zai-limit-error', at: NOW, windows: [], exhausted: { until: null, code: '1308' } }, NOW).record;
  assert.equal(viewOf(open, NOW + MIN).state, 'exhausted');
  assert.equal(viewOf(open, NOW + STALE_MS + MIN).state, 'unknown');
  // Launches since the read make the numbers an estimate.
  assert.equal(viewOf(record, NOW).confidence, 'exact');
  assert.equal(viewOf(used(record, NOW), NOW).confidence, 'estimated');
});

test('schedule: just after a predicted reset, often while exhausted or used, rarely while idle, back-off on failures, jitter bounded', () => {
  const at = (record, now = NOW, random = 0.5) => nextReadAt({ record, now, random }) - now;
  assert.equal(at(emptyRecord()), 0, 'never read: read now');
  const idle = observe(emptyRecord(), read([window('zai:tokens:300', 20, NOW + 4 * H)], NOW), NOW).record;
  assert.equal(at(idle), SCHEDULE.dormantMs);
  assert.equal(at(used(idle, NOW)), SCHEDULE.activeMs);
  const near = observe(emptyRecord(), read([window('zai:tokens:300', 20, NOW + 10 * MIN)], NOW), NOW).record;
  assert.equal(at(near, NOW, 0), 10 * MIN + SCHEDULE.afterResetMs);
  const full = observe(emptyRecord(), read([window('zai:tokens:300', 100, NOW + 3 * H)], NOW), NOW).record;
  assert.equal(at(full), SCHEDULE.exhaustedMs);
  let failing = idle;
  for (let i = 0; i < 12; i++) failing = readFailed(failing, 'down', NOW);
  assert.equal(at(failing), SCHEDULE.failureMaxMs);
  assert.equal(at(readFailed(idle, 'down', NOW)), SCHEDULE.failureBaseMs);
  for (const random of [0, 0.999]) {
    const delay = at(idle, NOW, random);
    assert.ok(delay >= SCHEDULE.dormantMs * (1 - SCHEDULE.jitter) - 1 && delay <= SCHEDULE.dormantMs * (1 + SCHEDULE.jitter) + 1, String(delay));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The reader, with a fake network
// ---------------------------------------------------------------------------------------------------------------

const ACCOUNTS = [
  { id: 'glm', label: 'GLM', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude', 'opencode'] },
  { id: 'glm-cn', label: 'GLM CN', preset: 'custom-anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
  { id: 'mm', label: 'MiniMax', preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', agents: ['claude'] },
  { id: 'or', label: 'OR', preset: 'openrouter-anthropic', baseUrl: 'https://openrouter.ai/api', model: 'z-ai/glm-4.6', agents: ['claude'] },
  { id: 'glm-2', label: 'GLM two', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude', 'opencode'] }
];

function fakeNetwork(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = typeof answers === 'function' ? answers(url, calls.length) : answers.shift();
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
  };
  return { fetch, calls };
}

async function service(t, { answers, now, accounts = ACCOUNTS, keyOrigins } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-accounts-quota-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = {};
  const secrets = {};
  const logs = [];
  const emitted = [];
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: (event, data) => emitted.push({ event, data })
  };
  const network = fakeNetwork(answers ?? []);
  const clock = { now: now ?? NOW };
  const make = () => new AccountsService({ host, dataDir, quotaFetch: network.fetch, now: () => clock.now, random: () => 0.5 });
  const accountsService = make();
  await accountsService.save({ version: 1, accounts });
  for (const account of accounts) {
    secrets[`key.${account.id}`] = KEY;
    await accountsService.keyChanged(account.id);
  }
  if (keyOrigins) for (const [id, origin] of Object.entries(keyOrigins)) storage.accounts.keyOrigins[id] = origin;
  return { service: accountsService, storage, secrets, logs, emitted, network, clock, dataDir, host, reload: () => { const next = new AccountsService({ host, dataDir, saved: storage.accounts, quotaFetch: network.fetch, now: () => clock.now, random: () => 0.5 }); return next; } };
}

test('only Z.AI / BigModel accounts are read, each on its own host, with its own key, redirects refused', async (t) => {
  assert.equal(quotaUrlOf(ACCOUNTS[0]), 'https://api.z.ai/api/monitor/usage/quota/limit');
  assert.equal(quotaUrlOf(ACCOUNTS[1]), 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(quotaUrlOf(ACCOUNTS[2]), null);
  assert.equal(quotaUrlOf(ACCOUNTS[3]), null);
  assert.equal(quotaUrlOf({ preset: 'custom-anthropic', baseUrl: 'https://api.z.ai.evil.example/api' }), null);
  assert.equal(quotaUrlOf({ preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434' }), null);
  const lite = await fixture('quota-lite.json');
  const { service: s, network } = await service(t, { answers: () => ({ body: lite }) });
  await s.quota.tick();
  await s.quota.tick();
  await s.quota.tick();
  const hosts = network.calls.map(call => new URL(call.url).host).sort();
  assert.deepEqual(hosts, ['api.z.ai', 'api.z.ai', 'open.bigmodel.cn']);
  for (const call of network.calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(new URL(call.url).pathname, '/api/monitor/usage/quota/limit');
  }
});

test('no request without a key saved for the account\'s address', async (t) => {
  const { service: s, network, secrets, storage } = await service(t, { accounts: [ACCOUNTS[0]], answers: () => ({ body: {} }) });
  delete secrets['key.glm'];
  await s.quota.tick();
  assert.equal(network.calls.length, 0);
  assert.match(s.quota.view(ACCOUNTS[0]).note, /not readable: no key/u);
  secrets['key.glm'] = KEY;
  storage.accounts.keyOrigins.glm = 'https://other.example';
  const moved = new AccountsService({ host: { callHost: async (m, p) => m === 'secrets.get' ? secrets[p.key] : storage[p.key], log: () => {}, emit: () => {} }, dataDir: await mkdtemp(join(tmpdir(), 'q-')), saved: storage.accounts, quotaFetch: network.fetch, now: () => NOW });
  await moved.quota.tick();
  assert.equal(network.calls.length, 0);
});

test('the key never reaches logs, events, the state file, the page state or the routes, even in an error', async (t) => {
  const echo = { status: 500, body: `upstream said ${KEY} is wrong` };
  const { service: s, logs, emitted, dataDir, clock } = await service(t, { accounts: [ACCOUNTS[0]], answers: [echo, { status: 429, body: await fixtureText('error-1308.json') }] });
  await s.quota.tick();
  clock.now += 5 * MIN;
  await s.quota.tick();
  await s.quota.flush();
  const routes = await s.tool('list_routes', { provider: 'claude' });
  const everything = JSON.stringify({ logs, emitted, state: await s.state(), routes, file: await readFile(join(dataDir, 'quota.json'), 'utf8'), files: await readdir(dataDir) });
  assert.ok(!everything.includes(KEY), 'the key leaked');
  assert.ok(!everything.includes(KEY.slice(4, 20)), 'part of the key leaked');
});

test('exhaustion → pick_account skips the account → early reset read → it is picked again; events logged', async (t) => {
  const exhausted = await fixture('quota-exhausted.json');
  const lite = await fixture('quota-lite.json');
  const early = await fixture('quota-early-reset.json');
  const answers = [];
  const { service: s, clock, logs, emitted } = await service(t, { accounts: [ACCOUNTS[0], ACCOUNTS[4]], answers: () => answers.shift() ?? { body: lite } });
  answers.push({ body: exhausted }, { body: lite });
  await s.quota.tick();
  let routes = (await s.tool('list_routes', { provider: 'claude' })).content.routes;
  assert.deepEqual(routes.map(r => [r.accountId, r.state]), [['glm', 'quota-exhausted'], ['glm-2', 'ready']]);
  assert.equal(routes[0].quota.state, 'exhausted');
  assert.equal(routes[0].quota.resetsAt, new Date(NOW + 2 * H).toISOString());
  assert.equal(routes[1].quota.remainingPercent, 58);
  assert.equal(routes[1].quota.source, 'zai-quota-api');
  let pick = (await s.tool('pick_account', { provider: 'claude' })).content;
  assert.equal(pick.accountId, 'glm-2');
  assert.match(pick.why, /GLM \(glm-4\.6\): its quota is used up/u);
  // The exhausted account is read again within minutes, before its predicted reset: room again.
  clock.now += SCHEDULE.exhaustedMs + 30_000;
  answers.push({ body: early });
  await s.quota.tick();
  pick = (await s.tool('pick_account', { provider: 'claude' })).content;
  assert.equal(pick.accountId, 'glm');
  assert.ok(logs.some(entry => /quota glm: early reset/u.test(entry.message)), JSON.stringify(logs));
  assert.ok(emitted.some(entry => entry.event === 'quota' && entry.data.kind === 'early-reset' && entry.data.accountId === 'glm'));
});

test('a limit error from the quota endpoint (429 with 1308) exhausts the account until its reset time', async (t) => {
  const { service: s } = await service(t, { accounts: [ACCOUNTS[0]], answers: [{ status: 429, body: await fixtureText('error-1308.json') }] });
  await s.quota.tick();
  const view = s.quota.view(ACCOUNTS[0]);
  assert.equal(view.state, 'exhausted');
  assert.equal(view.resetsAt, Date.UTC(2026, 9, 21, 14));
});

test('state survives a restart with its read time; age is shown, and an old read counts as unknown', async (t) => {
  const { service: s, clock, reload } = await service(t, { accounts: [ACCOUNTS[0]], answers: [{ body: await fixture('quota-pro.json') }] });
  await s.quota.tick();
  await s.quota.flush();
  clock.now += 12 * MIN;
  const again = reload();
  const view = again.quota.view(ACCOUNTS[0]);
  assert.equal(view.observedAt, NOW);
  assert.equal(view.ageMinutes, 12);
  assert.equal(view.state, 'ok');
  assert.equal(view.confidence, 'estimated');
  assert.equal(view.remainingPercent, 36);
  clock.now += 30 * MIN;
  const stale = (await again.tool('list_routes', { provider: 'claude' })).content.routes[0];
  assert.equal(stale.state, 'ready');
  assert.equal(stale.quota.state, 'stale');
  assert.equal(stale.quota.ageMinutes, 42);
});

test('reads are bounded: never twice within 30 s, at most 40 an hour per account, failures back off', async (t) => {
  const { service: s, network, clock } = await service(t, { accounts: [ACCOUNTS[0]], answers: () => new Error('offline') });
  await s.quota.tick();
  assert.equal(network.calls.length, 1);
  await s.tool('list_routes', {});
  await s.readQuota('glm');
  await s.quota.tick();
  assert.equal(network.calls.length, 1, 'read again within 30 s');
  const view = s.quota.view(ACCOUNTS[0]);
  assert.match(view.note, /could not be reached/u);
  // Failures back off (2, 4, 8 … min); an hour of ticks makes only a handful of requests.
  for (let i = 0; i < 240; i++) { clock.now += 15_000; await s.quota.tick(); }
  assert.ok(network.calls.length <= 7, String(network.calls.length));
  // The hourly cap holds even for "read now" clicks.
  const lite = await fixture('quota-lite.json');
  const burst = await service(t, { accounts: [ACCOUNTS[0]], answers: () => ({ body: lite }) });
  for (let i = 0; i < 200; i++) { burst.clock.now += 31_000; await burst.service.readQuota('glm'); }
  assert.ok(burst.network.calls.length <= MAX_READS_PER_HOUR * 2 + 1, String(burst.network.calls.length));
});

test('a launch on an account counts until the next read and makes it read more often', async (t) => {
  const { service: s } = await service(t, { accounts: [ACCOUNTS[0]], answers: [{ body: await fixture('quota-lite.json') }] });
  await s.quota.tick();
  s.quota.used(ACCOUNTS[0]);
  s.quota.used(ACCOUNTS[0]);
  const view = s.quota.view(ACCOUNTS[0]);
  assert.equal(view.launchesSinceRead, 2);
  assert.match(view.note, /2 launch\(es\) since the read/u);
});

test('passive limits for an account whose quota cannot be read (MiniMax) are kept and expire', async (t) => {
  const { service: s, clock } = await service(t, { accounts: [ACCOUNTS[2]] });
  assert.equal(s.quota.view(ACCOUNTS[2]), null);
  s.quota.noteLimit(ACCOUNTS[2], { source: 'host-activity', at: NOW, windows: [], exhausted: { until: NOW + H, code: 'limit' } });
  await s.quota.tick();
  assert.equal(s.quota.view(ACCOUNTS[2]).state, 'exhausted');
  clock.now += H + MIN;
  assert.equal(s.quota.view(ACCOUNTS[2]).state, 'presumed-reset');
  const routes = (await s.tool('list_routes', { provider: 'claude' })).content.routes;
  assert.equal(routes[0].state, 'ready');
});

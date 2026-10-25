// Coding-plan subscriptions (GLM Coding Plan, MiniMax Coding Plan) against a fake host (storage, secrets, card events)
// and a fake network answering with hand-written fixtures: adding and removing a plan account, the key bound to the
// plan's host, GLM and MiniMax quota, the pool's pick by headroom under each account's card limit, the launch for
// Claude Code and OpenCode (the key only as a secret reference), routes and shares with kind "subscription", and
// accounts saved earlier with a Z.AI or MiniMax preset turning up as plan accounts with their keys. No real key, no
// provider is contacted: every key below is assembled at runtime.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService } from '../src/service/accounts.ts';
import { parseMiniMaxQuota, parseMiniMaxLimitError } from '../src/quota/minimax.ts';
import { quotaUrlOf } from '../src/quota/reader.ts';
import { planOf, planLaunchAccount, newPlanAccount } from '../src/plans/plans.ts';
import { validateAccount } from '../src/shared/accounts.ts';
import { OPENCODE_NATIVE_AGENTS } from '../src/launch/harness.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const H = 3_600_000;
const MIN = 60_000;
const KEY = ['plan', 'fixture', 'c0de'.repeat(6)].join('.');
const PAYG = ['sk', 'api', 'fixture', 'feed'.repeat(5)].join('-');
const mm = async name => JSON.parse(await readFile(new URL(`./fixtures/minimax/${name}`, import.meta.url), 'utf8'));
const zai = async name => JSON.parse(await readFile(new URL(`./fixtures/zai/${name}`, import.meta.url), 'utf8'));
/** Z.AI quota with this much of the 5 h window used. */
const zaiUsed = percent => ({ code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: percent, nextResetTime: NOW + 2 * H }], level: 'pro' } });

async function fixture(t, { accounts = [], answers = () => ({ body: {} }), events = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-plans-data-'));
  const project = await mkdtemp(join(tmpdir(), 'canvastty-plans-project-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  const storage = {};
  const secrets = {};
  const logs = [];
  const emitted = [];
  const calls = [];
  const clock = { now: NOW };
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      if (method === 'sessions.subscribe') { if (!events) throw new Error('no events'); return { sessions: [] }; }
      if (method === 'limits.get') throw new Error('Unknown host method: limits.get.');
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: (event, data) => emitted.push({ event, data })
  };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = await answers(url, init);
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => typeof next.body === 'string' ? next.body : JSON.stringify(next.body) };
  };
  const make = (saved) => new AccountsService({ host, dataDir, quotaFetch: fetch, now: () => clock.now, random: () => 0.5, ...(saved ? { saved } : {}) });
  const service = make();
  await service.pools.start();
  t.after(() => service.pools.stop());
  if (accounts.length) await service.save({ version: 1, accounts });
  const context = (patch = {}) => ({ sessionId: 's1', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    chosen: true, environment: null, ...patch, options: { account: 'pool:glm', effort: 'default', trustFolder: false, ...patch.options } });
  const setKey = async (id, value = KEY) => { secrets[`key.${id}`] = value; await service.keyChanged(id); };
  return { service, storage, secrets, logs, emitted, calls, clock, host, context, setKey, dataDir, project, make };
}

// ---------------------------------------------------------------------------------------------------------------
// MiniMax quota shapes
// ---------------------------------------------------------------------------------------------------------------

test('MiniMax quota: the text model\'s 5 h and weekly windows; speech not in the plan and video never block', async () => {
  const current = parseMiniMaxQuota(await mm('remains-current.json'), NOW);
  assert.equal(current.source, 'minimax-quota-api');
  assert.deepEqual(current.windows.map(w => [w.id, w.label, w.usedPercent, w.windowMinutes, w.resetsAt, w.models]), [
    ['minimax:text:300', '5h', 40, 300, NOW + 2 * H, true],
    ['minimax:text:weekly', '7d', 20, 10_080, NOW + 3 * 24 * H, true],
    ['minimax:video:weekly', 'video 7d', 14.3, 10_080, NOW + 3 * 24 * H, false]
  ]);
  assert.equal(current.windows[0].used, 600);
  assert.equal(current.windows[0].limit, 1500);
  // Without a percentage the older meaning: the count is what is left (MiniMax-AI/cli resolveQuotaCounts).
  const legacy = parseMiniMaxQuota(await mm('remains-legacy.json'), NOW);
  assert.deepEqual(legacy.windows.filter(w => w.models).map(w => [w.id, w.usedPercent]), [['minimax:text:300', 84.8]]);
  const exhausted = parseMiniMaxQuota(await mm('remains-exhausted.json'), NOW);
  assert.equal(exhausted.windows[0].usedPercent, 100);
  const unlimitedWeek = parseMiniMaxQuota(await mm('remains-weekly-unlimited.json'), NOW);
  assert.deepEqual(unlimitedWeek.windows.map(w => w.id), ['minimax:text:300'], 'status 3 is unlimited: no window');
  await assert.rejects(async () => parseMiniMaxQuota(await mm('remains-auth.json'), NOW), error => error.kind === 'auth');
  assert.throws(() => parseMiniMaxQuota({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'speech-hd', current_interval_total_count: 10, current_interval_usage_count: 1 }] }, NOW), /no text-model window/u);
  assert.deepEqual(parseMiniMaxLimitError(await mm('error-usage-limit.json')), { code: '2056' });
  assert.equal(parseMiniMaxLimitError({ base_resp: { status_code: 1002, status_msg: 'rate limit, slow down' } }), null);
});

test('plans: an account on a plan\'s own host is a plan account; others are not', () => {
  assert.deepEqual(planOf({ preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic' }), { provider: 'glm', region: 'intl', host: 'api.z.ai' });
  assert.deepEqual(planOf({ preset: 'zai-openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }), { provider: 'glm', region: 'cn', host: 'open.bigmodel.cn' });
  assert.deepEqual(planOf({ preset: 'minimax-openai', baseUrl: 'https://api.minimaxi.com/v1' }), { provider: 'minimax', region: 'cn', host: 'api.minimaxi.com' });
  assert.equal(planOf({ preset: 'custom-anthropic', baseUrl: 'https://api.z.ai.example.test/api/anthropic' }), null);
  assert.equal(planOf({ preset: 'custom-anthropic', baseUrl: 'https://api.z.ai:8443/api/anthropic' }), null);
  assert.equal(planOf({ preset: 'openrouter-anthropic', baseUrl: 'https://openrouter.ai/api' }), null);
  assert.equal(quotaUrlOf({ preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.cn/anthropic' }), 'https://api.minimax.cn/v1/token_plan/remains');
  // Claude Code and OpenCode use the plan's Anthropic endpoint on the same host, even for an account saved with the OpenAI preset.
  const openai = { id: 'z', label: 'Z', preset: 'zai-openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', agents: ['opencode'] };
  assert.equal(planLaunchAccount(openai, 'opencode').baseUrl, 'https://api.z.ai/api/anthropic');
  assert.equal(planLaunchAccount(openai, 'qwen').baseUrl, 'https://api.z.ai/api/paas/v4');
  // A data level, a card limit or a small model belong to plan accounts only.
  assert.throws(() => validateAccount({ id: 'x', label: 'X', preset: 'custom-anthropic', baseUrl: 'https://llm.example.test', model: 'm', agents: ['claude'], trust: 'D1' }), /coding-plan account/u);
  assert.throws(() => validateAccount({ ...newPlanAccount({ id: 'g', provider: 'glm', region: 'intl', label: 'G', trust: 'unset' }), concurrency: 0 }), /1 to 16/u);
  assert.throws(() => validateAccount({ ...newPlanAccount({ id: 'g', provider: 'glm', region: 'intl', label: 'G', trust: 'unset' }), trust: 'D9' }), /trust/u);
});

// ---------------------------------------------------------------------------------------------------------------
// Adding, the key's host, removing
// ---------------------------------------------------------------------------------------------------------------

test('add a GLM (bigmodel.cn) and a MiniMax (minimax.io) subscription: the data level is asked, the key is bound to the plan host; remove', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.planAdd({ provider: 'glm', region: 'cn', label: 'Work' }), /how far you trust/u, 'nothing is chosen for the person');
  await assert.rejects(f.service.planAdd({ provider: 'kimi', region: 'cn', trust: 'unset' }), /GLM Coding Plan or MiniMax/u);
  await assert.rejects(f.service.planAdd({ provider: 'glm', region: 'mars', trust: 'unset' }), /region/u);
  const { id } = await f.service.planAdd({ provider: 'glm', region: 'cn', label: 'Work', trust: 'D2', concurrency: 3 });
  const { id: mmId } = await f.service.planAdd({ provider: 'minimax', region: 'intl', label: 'MM', trust: 'unset', brokerable: true });
  const saved = f.service.settings.accounts.find(account => account.id === id);
  assert.deepEqual({ ...saved }, { id, label: 'Work', preset: 'zai-anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', smallModel: 'glm-5.3-flash', agents: ['claude', 'opencode'], trust: 'D2', concurrency: 3 });
  assert.equal(f.service.settings.accounts.find(account => account.id === mmId).baseUrl, 'https://api.minimax.io/anthropic');
  await f.setKey(id);
  await f.setKey(mmId);
  assert.deepEqual(f.storage.accounts.keyOrigins, { [id]: 'https://open.bigmodel.cn', [mmId]: 'https://api.minimax.io' });
  const state = await f.service.state();
  assert.equal(state.keys[id], 'ok');
  assert.deepEqual(state.plans.accounts[id], { provider: 'glm', region: 'cn', host: 'open.bigmodel.cn', running: 0, concurrency: 3 });
  assert.deepEqual(state.plans.providers.map(entry => [entry.provider, entry.regions.map(region => region.host)]), [['glm', ['api.z.ai', 'open.bigmodel.cn']], ['minimax', ['api.minimax.io', 'api.minimax.cn']]]);
  // The account moved to another host: the key is never sent there; the person saves it again.
  await f.service.save({ version: 1, accounts: f.service.settings.accounts.map(account => account.id === id ? { ...account, baseUrl: 'https://api.z.ai/api/anthropic' } : account) });
  assert.equal((await f.service.state()).keys[id], 'other-address');
  const refused = await f.service.prepare(f.context({ options: { account: id } }));
  assert.match(refused.refuse.reason, /saved for another address/u);
  // Remove: the account, its key binding and its quota go.
  await f.service.save({ version: 1, accounts: f.service.settings.accounts.filter(account => account.id !== id) });
  assert.deepEqual(Object.keys(f.storage.accounts.keyOrigins), [mmId]);
  assert.deepEqual(Object.keys((await f.service.state()).plans.accounts), [mmId]);
});

test('accounts saved earlier with a Z.AI or MiniMax preset are plan accounts with their ids and keys (no re-entry)', async (t) => {
  const f = await fixture(t);
  const before = { version: 1, accounts: [
    { id: 'glm-old', label: 'GLM old', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] },
    { id: 'zai-oa', label: 'Z.AI OpenAI', preset: 'zai-openai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', agents: ['opencode', 'qwen'] },
    { id: 'mm-old', label: 'MiniMax old', preset: 'minimax-anthropic', baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2', agents: ['claude'], brokerable: true },
    { id: 'local', label: 'Local', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['claude'] }
  ] };
  const keyOrigins = { 'glm-old': 'https://api.z.ai', 'zai-oa': 'https://api.z.ai', 'mm-old': 'https://api.minimax.io' };
  for (const id of Object.keys(keyOrigins)) f.secrets[`key.${id}`] = KEY;
  const service = f.make({ settings: before, keyOrigins });
  const state = await service.state();
  assert.deepEqual(Object.keys(state.plans.accounts), ['glm-old', 'zai-oa', 'mm-old']);
  assert.deepEqual(state.settings.accounts.map(account => account.id), ['glm-old', 'zai-oa', 'mm-old', 'local'], 'ids kept, nothing rewritten');
  assert.deepEqual([state.keys['glm-old'], state.keys['zai-oa'], state.keys['mm-old']], ['ok', 'ok', 'ok'], 'their keys still apply');
  // The pool takes them for Claude Code and OpenCode; the OpenAI-preset one runs OpenCode on the Anthropic endpoint of its host.
  assert.ok(service.launchOptions('claude').account.some(option => option.value === 'pool:glm'));
  assert.ok(service.launchOptions('opencode').account.some(option => option.value === 'pool:minimax'));
  assert.ok(!service.launchOptions('codex').account.some(option => option.value.startsWith('pool:')));
  const oc = await service.prepare(f.context({ provider: 'opencode', options: { account: 'zai-oa' } }));
  const config = JSON.parse(oc.files[0].content);
  assert.equal(Object.values(config.provider)[0].options.baseURL, 'https://api.z.ai/api/anthropic/v1');
  assert.equal(Object.values(config.provider)[0].npm, '@ai-sdk/anthropic');
  // Qwen keeps the account as saved.
  const qwen = await service.prepare(f.context({ provider: 'qwen', options: { account: 'zai-oa' } }));
  assert.equal(qwen.env.OPENAI_BASE_URL, 'https://api.z.ai/api/paas/v4');
  const offers = service.brokerOffer();
  assert.deepEqual(offers.map(offer => [offer.id, offer.flatRate, offer.baseUrl]), [['mm-old', true, 'https://api.minimax.io/anthropic/v1']]);
});

// ---------------------------------------------------------------------------------------------------------------
// The pool: headroom, card limits, launches
// ---------------------------------------------------------------------------------------------------------------

const glmAccounts = () => [
  { ...newPlanAccount({ id: 'g-low', provider: 'glm', region: 'intl', label: 'Low', trust: 'D1' }) },
  { ...newPlanAccount({ id: 'g-high', provider: 'glm', region: 'intl', label: 'High', trust: 'D3', concurrency: 2 }) },
  { ...newPlanAccount({ id: 'g-out', provider: 'glm', region: 'intl', label: 'Out', trust: 'D3' }) },
  { ...newPlanAccount({ id: 'g-nokey', provider: 'glm', region: 'intl', label: 'No key', trust: 'D3' }) }
];

async function glmPool(t) {
  const used = { 'g-low': 80, 'g-high': 30, 'g-out': 100 };
  const f = await fixture(t, { accounts: glmAccounts(), answers: (url, init) => {
    const id = Object.keys(used).find(key => init.headers.Authorization === `Bearer ${KEY}-${key}`);
    return { body: zaiUsed(used[id] ?? 0) };
  } });
  for (const id of Object.keys(used)) await f.setKey(id, `${KEY}-${id}`);
  for (let i = 0; i < 3; i++) await f.service.quota.tick();
  return f;
}

test('pool:glm launches on the account with the most room, skips used-up and keyless ones, and keeps each account under its card limit', async (t) => {
  const f = await glmPool(t);
  assert.equal(f.calls.length, 3, 'only accounts with a key are read');
  const homeOf = answer => answer.env?.CLAUDE_CONFIG_DIR ?? answer.secretEnv?.CTTY_MODEL_API_KEY;
  const on = id => [join(f.dataDir, 'homes', `claude-${id}`), `key.${id}`];
  const first = await f.service.prepare(f.context({ sessionId: 'c1' }));
  assert.ok(on('g-high').includes(homeOf(first)), 'the most room (70 % left)');
  // High was used since its read (its quota is now an estimate): the exact one goes next, as in subscription pools.
  const second = await f.service.prepare(f.context({ sessionId: 'c2', provider: 'opencode' }));
  assert.ok(on('g-low').includes(homeOf(second)));
  const third = await f.service.prepare(f.context({ sessionId: 'c3' }));
  assert.ok(on('g-high').includes(homeOf(third)), 'two cards at once on one key');
  const fourth = await f.service.prepare(f.context({ sessionId: 'c4' }));
  assert.ok(on('g-low').includes(homeOf(fourth)), 'High is at its limit of 2');
  // Everyone at the limit, used up or without a key: refused with the reasons.
  const none = await f.service.prepare(f.context({ sessionId: 'c5' }));
  assert.match(none.refuse.reason, /^No GLM Coding Plan account can take this card now: 2 at the card limit the person set \(Low, High\); 1 no key is saved for it \(No key\); 1 its quota is used up \(Out\)\.$/u);
  // A card ends: High has room again.
  f.service.sessionEvent({ type: 'exited', session: { id: 'c1' } });
  const sixth = await f.service.prepare(f.context({ sessionId: 'c6' }));
  assert.ok(on('g-high').includes(homeOf(sixth)));
  // A restored card stays on the account it ran on.
  f.service.sessionEvent({ type: 'exited', session: { id: 'c2' } });
  const restored = await f.service.prepare(f.context({ sessionId: 'c2', restoring: true }));
  assert.equal(restored.env.CLAUDE_CONFIG_DIR, join(f.dataDir, 'homes', 'claude-g-low'));
  // Not Codex: the plan pool runs Claude Code and OpenCode.
  assert.match((await f.service.prepare(f.context({ sessionId: 'x', provider: 'codex' }))).refuse.reason, /runs Claude Code and OpenCode/u);
});

test('the launch for Claude Code and OpenCode: plan endpoint, model mapping, key only as a secret reference', async (t) => {
  const f = await fixture(t);
  const { id } = await f.service.planAdd({ provider: 'minimax', region: 'cn', label: 'MM China', trust: 'D1' });
  const { id: glm } = await f.service.planAdd({ provider: 'glm', region: 'intl', label: 'GLM', trust: 'D1' });
  await f.setKey(id);
  await f.setKey(glm);
  const claude = await f.service.prepare(f.context({ options: { account: 'pool:minimax', effort: 'high' } }));
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://api.minimax.cn/anthropic');
  assert.equal(claude.env.ANTHROPIC_API_KEY, '');
  // MiniMax's list (bundled here): MiniMax-M3 for the main slots, MiniMax-M3.1-Flash (newer, a Flash) for Haiku.
  assert.equal(claude.env.ANTHROPIC_MODEL, 'MiniMax-M3');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'MiniMax-M3.1-Flash');
  assert.deepEqual(claude.secretEnv, { ANTHROPIC_AUTH_TOKEN: `key.${id}` });
  assert.equal(claude.thirdPartyModel, true);
  assert.deepEqual(claude.args.slice(-2), ['--effort', 'high']);
  const glmClaude = await f.service.prepare(f.context({ sessionId: 's2' }));
  assert.equal(glmClaude.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.deepEqual([glmClaude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, glmClaude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, glmClaude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['glm-5.3', 'glm-5.3', 'glm-5.3-flash']);
  assert.ok(glmClaude.args.includes('--settings'));
  const oc = await f.service.prepare(f.context({ sessionId: 's3', provider: 'opencode' }));
  const config = JSON.parse(oc.files[0].content);
  const providerId = Object.keys(config.provider)[0];
  assert.deepEqual(config.enabled_providers, [providerId]);
  assert.equal(config.provider[providerId].options.baseURL, 'https://api.z.ai/api/anthropic/v1');
  assert.equal(config.provider[providerId].options.apiKey, '{env:CTTY_MODEL_API_KEY}');
  assert.deepEqual(Object.keys(config.provider[providerId].models), ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(config.model, `${providerId}/glm-5.3`);
  assert.equal(config.small_model, `${providerId}/glm-5.3-flash`);
  assert.deepEqual(Object.keys(config.agent).sort(), [...OPENCODE_NATIVE_AGENTS].sort(), 'every native agent pinned');
  assert.ok(Object.values(config.agent).every(agent => agent.model.startsWith(`${providerId}/`)));
  assert.deepEqual(oc.secretEnv, { CTTY_MODEL_API_KEY: `key.${glm}` });
  // Effort is Claude Code's: OpenCode with an effort is refused, not silently ignored.
  assert.match((await f.service.prepare(f.context({ sessionId: 's4', provider: 'opencode', options: { effort: 'high' } }))).refuse.reason, /effort/u);
  const everything = JSON.stringify({ claude, glmClaude, oc, logs: f.logs, emitted: f.emitted, state: await f.service.state() });
  assert.ok(!everything.includes(KEY), 'the key never reaches args, env, files, logs or the page');
});

test('a plan account by name: a subagent over its card limit is refused; the person\'s own launch is not', async (t) => {
  const f = await glmPool(t);
  for (const session of ['a', 'b']) await f.service.prepare(f.context({ sessionId: session, options: { account: 'g-high' } }));
  const sub = await f.service.prepare(f.context({ sessionId: 'c', role: 'subagent', options: { account: 'g-high' } }));
  assert.match(sub.refuse.reason, /already runs 2 card\(s\).*pool:glm/u);
  const own = await f.service.prepare(f.context({ sessionId: 'd', options: { account: 'g-high' } }));
  assert.equal(own.refuse, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// Orchestrators and readers
// ---------------------------------------------------------------------------------------------------------------

test('list_routes, pick_account and shares: plan accounts are kind "subscription" with quota, trust and the plan pool', async (t) => {
  const f = await glmPool(t);
  const routes = (await f.service.tool('list_routes', { provider: 'claude' })).content.routes;
  assert.deepEqual(routes.map(row => [row.accountId, row.kind, row.plan, row.state]), [
    ['g-low', 'subscription', 'glm', 'ready'], ['g-high', 'subscription', 'glm', 'ready'], ['g-out', 'subscription', 'glm', 'quota-exhausted'], ['g-nokey', 'subscription', 'glm', 'no-key']]);
  assert.equal(routes[1].quota.remainingPercent, 70);
  assert.equal(routes[1].quota.confidence, 'exact');
  assert.equal(routes[0].trust, 'D1');
  const strict = (await f.service.tool('list_routes', { provider: 'claude', dataClass: 'D2', dataClassMode: 'strict' })).content.routes;
  assert.deepEqual(strict.find(row => row.accountId === 'g-low').state, 'data-class');
  // pick_account: the most room, reserved so parallel picks spread; then the next one.
  const one = (await f.service.tool('pick_account', { provider: 'claude' })).content;
  assert.deepEqual([one.accountId, one.kind, one.plan], ['g-high', 'subscription', 'glm']);
  assert.deepEqual(one.spawn, { provider: 'claude', launchOptions: { 'canvastty-accounts': { account: 'g-high', effort: 'default', trustFolder: false } } });
  assert.match(one.why, /30% used, 70% left \(exact\)/u);
  assert.equal((await f.service.tool('pick_account', { provider: 'opencode' })).content.accountId, 'g-high', 'a cap of 2');
  assert.equal((await f.service.tool('pick_account', { provider: 'claude' })).content.accountId, 'g-low');
  // The picked launch uses its reservation instead of counting twice.
  await f.service.prepare(f.context({ sessionId: 'p1', role: 'subagent', options: { account: 'g-high' } }));
  assert.equal((await f.service.tool('pick_account', { provider: 'claude', dataClass: 'D2', dataClassMode: 'strict' })).isError, true, 'High is at its cap; Low is below D2');
  // Shares.
  const shared = await f.service.shareRead({ caller: { pluginId: 'x' }, method: 'accounts.routes', params: {} });
  assert.ok(shared.routes.some(row => row.accountId === 'g-high' && row.kind === 'subscription' && row.plan === 'glm'));
  assert.deepEqual(shared.plans.map(pool => [pool.plan, pool.members, pool.agents, pool.launchOptions['canvastty-accounts'].account]), [['glm', 4, ['claude', 'opencode'], 'pool:glm']]);
  const quota = await f.service.shareRead({ caller: { pluginId: 'x' }, method: 'accounts.quota', params: {} });
  const high = quota.accounts.find(entry => entry.accountId === 'g-high');
  assert.deepEqual([high.kind, high.plan, high.concurrency, high.trust, high.quota.remainingPercent], ['subscription', 'glm', 2, 'D3', 70]);
  const everything = JSON.stringify({ routes, shared, quota });
  assert.ok(!everything.includes(KEY), 'no key in routes or shares');
  assert.ok(!everything.includes(f.dataDir), 'no paths');
});

test('MiniMax: the plan quota is read on its own host with a Bearer key; a pay-as-you-go key is never sent; a limit error rests the account', async (t) => {
  let answer = { body: null };
  const f = await fixture(t, { answers: () => answer });
  answer = { body: await mm('remains-current.json') };
  const { id } = await f.service.planAdd({ provider: 'minimax', region: 'intl', label: 'MM', trust: 'D1' });
  await f.setKey(id);
  await f.service.quota.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.minimax.io/v1/token_plan/remains');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(f.calls[0].init.redirect, 'error');
  const view = f.service.quota.view(f.service.settings.accounts[0]);
  assert.deepEqual([view.state, view.remainingPercent, view.window, view.confidence], ['ok', 60, '5h', 'exact']);
  // A limit answer: used up until the window's reset known from the last read.
  f.clock.now += 5 * MIN;
  answer = { status: 429, body: await mm('error-usage-limit.json') };
  await f.service.readQuota(id);
  const out = f.service.quota.view(f.service.settings.accounts[0]);
  assert.equal(out.state, 'exhausted');
  assert.equal(out.resetsAt, NOW + 2 * H);
  assert.match((await f.service.prepare(f.context({ options: { account: 'pool:minimax' } }))).refuse.reason, /quota is used up/u);
  // A pay-as-you-go key: no request, quota unknown (never "used up").
  const g = await fixture(t, { answers: () => ({ body: {} }) });
  const { id: payg } = await g.service.planAdd({ provider: 'minimax', region: 'intl', label: 'PAYG', trust: 'unset' });
  await g.setKey(payg, PAYG);
  await g.service.quota.tick();
  assert.equal(g.calls.length, 0);
  assert.equal(g.service.quota.view(g.service.settings.accounts[0]).state, 'unknown');
  assert.ok(!JSON.stringify(g.logs).includes(PAYG));
});

test('GLM quota: the plan account reads Z.AI\'s quota endpoint exactly as model accounts did', async (t) => {
  const f = await fixture(t, { answers: async () => ({ body: await zai('quota-pro.json') }) });
  const { id } = await f.service.planAdd({ provider: 'glm', region: 'intl', label: 'GLM', trust: 'D1' });
  await f.setKey(id);
  assert.equal(quotaUrlOf(f.service.settings.accounts[0]), 'https://api.z.ai/api/monitor/usage/quota/limit');
  await f.service.quota.tick();
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.z.ai/api/monitor/usage/quota/limit']);
  const view = f.service.quota.view(f.service.settings.accounts[0]);
  assert.deepEqual([view.state, view.remainingPercent, view.confidence, view.source], ['ok', 36, 'exact', 'zai-quota-api']);
});

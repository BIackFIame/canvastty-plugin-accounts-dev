// Subscription account pools against a fake host (storage, sessions, limits) and fake CLIs: add + sign-in card, the
// fake CLI's sign-in writing a fake credential into the account home, quota from fake `limits.get` answers, the pick
// with the most headroom, one card per sign-in, used-up and early-reset handling, removal, and no secret anywhere.
// No real CLI, credential, keychain or network is touched: every token below is a fixture assembled at runtime.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { AccountsService } from '../src/service/accounts.ts';
import { rankPool, covers, newPoolId, loadPools } from '../src/pools/model.ts';
import { limitsObservation, probeSignIn, CORE_HOME_LIMIT } from '../src/pools/service.ts';
import { POOL_INFO } from '../src/pools/providers.ts';

const run = promisify(execFile);
const TOKEN = ['fixture', 'refresh', 'tok', 'c0ffee'.repeat(6)].join('-');
const ACCESS = ['fixture', 'access', 'tok', 'beef'.repeat(8)].join('-');
const EMAIL = ['pool.fixture', 'example.test'].join('@');
const MIN = 60_000;

/** A fake agent CLI: its "sign-in" writes a fake credential into the home its own variable names, as the real CLIs do. */
async function fakeCli(dir) {
  const path = join(dir, 'fake-cli.mjs');
  await writeFile(path, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [provider] = process.argv.slice(2);
    const home = process.env[{ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME', kimi: 'KIMI_CODE_HOME' }[provider]];
    if (!home) { console.error('no home'); process.exit(2); }
    const secret = JSON.stringify({ refresh_token: process.env.FAKE_REFRESH, access_token: process.env.FAKE_ACCESS });
    if (provider === 'kimi') { mkdirSync(join(home, 'credentials'), { recursive: true }); writeFileSync(join(home, 'credentials', 'kimi-code.json'), secret, { mode: 0o600 }); }
    else if (provider === 'claude') writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: process.env.FAKE_EMAIL } }));
    else writeFileSync(join(home, 'auth.json'), secret, { mode: 0o600 });
    console.log('signed in');
  `);
  return path;
}

const windowOf = (id, usedPercent, resetsAt, minutes = 300, extra = {}) => ({ id, bucketId: 'default', slot: 'primary', isDefaultBucket: true, label: null, usedPercent, used: null, limit: null, windowMinutes: minutes, resetsAt, ...extra });
const available = (provider, fetchedAt, windows) => ({ state: 'ready', snapshot: { fetchedAt, providers: [{ provider, state: 'available', source: 'x', fetchedAt, windows }] } });
const unavailable = (provider, reason, at) => ({ state: 'ready', snapshot: { fetchedAt: at, providers: [{ provider, state: 'unavailable', source: 'x', checkedAt: at, reason }] } });

async function fixture(t, { limits = 'yes', events = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-pools-data-'));
  const project = await mkdtemp(join(tmpdir(), 'canvastty-pools-project-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }); });
  let now = Date.parse('2026-10-21T10:00:00Z');
  const storage = {};
  const logs = [];
  const emitted = [];
  const created = [];
  const limitCalls = [];
  /** home -> answer (or a function of the call count). */
  const homeLimits = new Map();
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return null;
      if (method === 'sessions.subscribe') { if (!events) throw new Error('Plugin does not have the sessions:events permission.'); return { sessions: [] }; }
      if (method === 'sessions.create') { const sessionId = `card-${created.length + 1}`; created.push({ ...structuredClone(params), sessionId }); return { sessionId }; }
      if (method === 'limits.get') {
        limitCalls.push(structuredClone(params));
        if (limits === 'missing') throw new Error('Unknown host method: limits.get.');
        const answer = homeLimits.get(params.home);
        if (answer instanceof Error) throw answer;
        // Nothing set for this home: CanvasTTY could not read it this time (unknown, never "signed out").
        if (!answer) return unavailable(params.provider, 'timeout', now);
        return typeof answer === 'function' ? answer() : answer;
      }
      throw new Error(`host: ${method} not allowed`);
    },
    log: (level, message) => logs.push({ level, message }),
    emit: (event, data) => emitted.push({ event, data })
  };
  const service = new AccountsService({ host, dataDir, now: () => now, random: () => 0.5 });
  await service.pools.start();
  const context = (patch = {}) => ({ sessionId: 's1', provider: 'codex', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false,
    chosen: true, environment: null, ...patch, options: { account: 'pool:codex', effort: 'default', trustFolder: false, ...patch.options } });
  const cli = await fakeCli(dataDir);
  /** Runs the fake CLI with exactly the environment the contribution gives (what CanvasTTY would start it with). */
  const signInWith = async (contribution, provider) => {
    await run(process.execPath, [cli, provider], { env: { PATH: process.env.PATH, ...contribution.env, FAKE_REFRESH: TOKEN, FAKE_ACCESS: ACCESS, FAKE_EMAIL: EMAIL } });
  };
  /** Adds an account and completes its sign-in card with the fake CLI. */
  const addSignedIn = async (provider, label, trust = 'unset') => {
    const added = await service.poolAdd({ provider, label, trust });
    const card = created.at(-1);
    const answer = await service.prepare(context({ sessionId: card.sessionId, provider, options: card.launchOptions['canvastty-accounts'] }));
    assert.ok(!answer.refuse, JSON.stringify(answer));
    await signInWith(answer, provider);
    service.pools.sessionEvent({ type: 'exited', session: { id: card.sessionId } });
    service.pools.sessionEvent({ type: 'closed', session: { id: card.sessionId } });
    await service.poolCheck(added.id);
    return added.id;
  };
  return {
    dataDir, project, storage, logs, emitted, created, limitCalls, homeLimits, service, host, context, signInWith, addSignedIn,
    home: id => join(dataDir, 'pools', id),
    advance: ms => { now += ms; }, now: () => now
  };
}

test('ranking: exact quota first, then estimated, then unknown; most headroom; used up, busy and signed-out skipped', () => {
  const view = (state, remainingPercent, confidence, extra = {}) => ({ state, remainingPercent, confidence, window: null, resetsAt: null, source: null, observedAt: null, ageMinutes: null, launchesSinceRead: 0, note: 'n', ...extra });
  const accounts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => ({ id, provider: 'grok', label: id.toUpperCase(), trust: 'unset', addedAt: index }));
  const facts = {
    a: { signIn: 'signed-in', quota: view('unknown', null, 'none'), active: 0, lastUsedAt: null },
    b: { signIn: 'signed-in', quota: view('ok', 90, 'estimated'), active: 0, lastUsedAt: null },
    c: { signIn: 'signed-in', quota: view('ok', 40, 'exact'), active: 0, lastUsedAt: null },
    d: { signIn: 'signed-in', quota: view('ok', 80, 'exact'), active: 0, lastUsedAt: null },
    e: { signIn: 'signed-in', quota: view('exhausted', 0, 'exact'), active: 0, lastUsedAt: null },
    f: { signIn: 'signed-in', quota: view('ok', 99, 'exact'), active: 1, lastUsedAt: null },
    g: { signIn: 'signed-out', quota: view('unknown', null, 'none'), active: 0, lastUsedAt: null }
  };
  const { ranked, skipped } = rankPool(accounts, account => facts[account.id]);
  assert.deepEqual(ranked.map(entry => entry.account.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(skipped.map(entry => entry.account.id), ['e', 'f', 'g']);
  assert.match(skipped.find(entry => entry.account.id === 'f').reason, /one card per sign-in/);
  // Running low goes after everything with room, even an unknown one.
  facts.d.quota = view('low', 5, 'exact');
  assert.deepEqual(rankPool(accounts, account => facts[account.id]).ranked.map(entry => entry.account.id), ['c', 'b', 'a', 'd']);
  // Same headroom bucket: the one used least recently goes first.
  facts.c.quota = view('ok', 85, 'exact'); facts.d.quota = view('ok', 88, 'exact'); facts.d.lastUsedAt = 5; facts.c.lastUsedAt = 9;
  assert.deepEqual(rankPool(accounts, account => facts[account.id]).ranked.slice(0, 2).map(entry => entry.account.id), ['d', 'c']);
});

test('data class is the person\'s choice: strict skips accounts below the task, warn ranks them last, off ignores it; unset never covers', () => {
  const view = { state: 'ok', remainingPercent: 50, confidence: 'exact', window: null, resetsAt: null, source: null, observedAt: null, ageMinutes: null, launchesSinceRead: 0, note: '' };
  const accounts = [
    { id: 'low', provider: 'claude', label: 'Low', trust: 'D1', addedAt: 0 },
    { id: 'unset', provider: 'claude', label: 'Unset', trust: 'unset', addedAt: 1 },
    { id: 'high', provider: 'claude', label: 'High', trust: 'D3', addedAt: 2 }
  ];
  const facts = () => ({ signIn: 'signed-in', quota: view, active: 0, lastUsedAt: null });
  assert.equal(covers('unset', 'D0'), false);
  assert.equal(covers('D2', 'D2'), true);
  const strict = rankPool(accounts, facts, { dataClass: 'D2', mode: 'strict' });
  assert.deepEqual(strict.ranked.map(entry => entry.account.id), ['high']);
  assert.match(strict.skipped.find(entry => entry.account.id === 'unset').reason, /not set its data level/);
  const warn = rankPool(accounts, facts, { dataClass: 'D2' });
  assert.deepEqual(warn.ranked.map(entry => entry.account.id), ['high', 'low', 'unset']);
  assert.match(warn.ranked[1].note, /warned only/);
  assert.deepEqual(rankPool(accounts, facts, { dataClass: 'D2', mode: 'off' }).ranked.map(entry => entry.account.id), ['low', 'unset', 'high']);
});

test('saved pools: invalid entries dropped, ids unique, no cap below the storage bound', () => {
  const many = Array.from({ length: 60 }, (_, n) => ({ id: `grok-${n}`, provider: 'grok', label: `Grok ${n}`, trust: 'unset', addedAt: n }));
  assert.equal(loadPools({ accounts: [...many, { id: 'Bad id', provider: 'grok', label: 'x', trust: 'unset' }, { id: 'q', provider: 'qwen', label: 'x', trust: 'unset' }, many[0]] }).accounts.length, 60);
  assert.equal(newPoolId('grok', 'Grok 7', new Set()), 'grok-grok-7');
  assert.equal(newPoolId('grok', 'Grok 7', new Set(['grok-grok-7'])), 'grok-grok-7-2');
});

test('add: the data level must be answered; the home is created inside the plugin folder; the CLI\'s own sign-in runs in a card', async (t) => {
  const { service, created, dataDir, context, signInWith, home } = await fixture(t);
  await assert.rejects(service.poolAdd({ provider: 'grok', label: 'Grok 1' }), /how far you trust/);
  await assert.rejects(service.poolAdd({ provider: 'qwen', label: 'Q', trust: 'unset' }), /Qwen Code has no variable/);
  await assert.rejects(service.poolAdd({ provider: 'opencode', label: 'O', trust: 'unset' }), /API key/);
  const added = await service.poolAdd({ provider: 'grok', label: 'Grok 1', trust: 'unset' });
  assert.equal(added.id, 'grok-grok-1');
  assert.deepEqual(added.signIn, { sessionId: 'card-1' });
  assert.ok(existsSync(home(added.id)));
  assert.ok(home(added.id).startsWith(join(dataDir, 'pools')));
  const card = created[0];
  assert.equal(card.provider, 'grok');
  assert.equal(card.profile, 'normal');
  assert.match(card.title, /Sign in · Grok 1/);
  const value = card.launchOptions['canvastty-accounts'].account;
  assert.match(value, /^signin:grok-grok-1:[0-9a-f]{24}$/);
  assert.equal(service.pools.view().providers.find(entry => entry.provider === 'grok').accounts[0].signIn, 'signed-out');

  // A subagent, a restore and a guessed nonce never get a sign-in card.
  for (const patch of [{ role: 'subagent' }, { restoring: true }, { resume: true }]) {
    const refused = await service.prepare(context({ sessionId: 'card-1', provider: 'grok', ...patch, options: { account: value } }));
    assert.match(refused.refuse.reason, /not current/);
  }
  assert.match((await service.prepare(context({ sessionId: 'card-1', provider: 'grok', options: { account: 'signin:grok-grok-1:000000000000000000000000' } }))).refuse.reason, /not current/);
  const answer = await service.prepare(context({ sessionId: 'card-1', provider: 'grok', options: { account: value } }));
  assert.deepEqual(answer.env, { GROK_HOME: home(added.id) });
  assert.deepEqual(answer.args, []);
  // Used once only.
  assert.match((await service.prepare(context({ sessionId: 'card-9', provider: 'grok', options: { account: value } }))).refuse.reason, /not current/);

  await signInWith(answer, 'grok');
  assert.equal(await probeSignIn('grok', home(added.id)), 'signed-in');
  service.pools.sessionEvent({ type: 'exited', session: { id: 'card-1' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.pools.view().providers.find(entry => entry.provider === 'grok').accounts[0].signIn, 'signed-in');
});

test('each CLI signs in into its own home variable; Claude counts as signed in from its account marker only', async (t) => {
  const { addSignedIn, service, home } = await fixture(t);
  for (const provider of ['claude', 'codex', 'grok', 'kimi']) {
    const id = await addSignedIn(provider, `${provider} one`);
    assert.equal(await probeSignIn(provider, home(id)), 'signed-in', provider);
    assert.equal(POOL_INFO[provider].perHome, 'one');
  }
  const accounts = service.pools.view().providers.flatMap(entry => entry.accounts);
  assert.equal(accounts.length, 4);
  assert.ok(accounts.every(account => account.signIn === 'signed-in'));
});

test('a pool launch picks the signed-in account with the most room, reads quota through CanvasTTY per home, and keeps one card per sign-in', async (t) => {
  const { service, addSignedIn, homeLimits, home, context, now, limitCalls, advance } = await fixture(t);
  const a = await addSignedIn('codex', 'Codex A');
  const b = await addSignedIn('codex', 'Codex B');
  const c = await addSignedIn('codex', 'Codex C');
  homeLimits.set(home(a), available('codex', now(), [windowOf('primary', 70, now() + 120 * MIN)]));
  homeLimits.set(home(b), available('codex', now(), [windowOf('primary', 20, now() + 200 * MIN), windowOf('secondary', 30, now() + 5 * 1440 * MIN, 10080)]));
  homeLimits.set(home(c), available('codex', now(), [windowOf('primary', 100, now() + 60 * MIN)]));
  for (const id of [a, b, c]) await service.poolCheck(id);
  assert.ok(limitCalls.every(call => call.provider === 'codex' && [home(a), home(b), home(c)].includes(call.home)));

  const first = await service.prepare(context({ sessionId: 'x1' }));
  assert.deepEqual(first.env, { CODEX_HOME: home(b), CODEX_API_KEY: '', CODEX_ACCESS_TOKEN: '' });
  // B now runs a card: the next goes to A; C is used up.
  const second = await service.prepare(context({ sessionId: 'x2' }));
  assert.equal(second.env.CODEX_HOME, home(a));
  const third = await service.prepare(context({ sessionId: 'x3' }));
  assert.match(third.refuse.reason, /No Codex pool account can take this card now: 2 a card already runs on it.*1 its quota is used up/);
  // An explicit pick of a busy account is refused too (one card per sign-in).
  assert.match((await service.prepare(context({ sessionId: 'x4', options: { account: `sub:${a}` } }))).refuse.reason, /already runs a card/);
  // Codex's limits read starts its app-server in the home: never while a card runs there.
  const before = limitCalls.length;
  advance(10 * MIN);
  await service.pools.tick();
  assert.ok(limitCalls.slice(before).every(call => call.home === home(c)), 'busy Codex homes are not read');
  // The card on B ends: B is free again.
  service.pools.sessionEvent({ type: 'exited', session: { id: 'x1' } });
  assert.equal((await service.prepare(context({ sessionId: 'x5' }))).env.CODEX_HOME, home(b));
  // A restored card continues on the account its conversation lives in, even when another has more room.
  service.pools.sessionEvent({ type: 'exited', session: { id: 'x2' } });
  const restored = await service.prepare(context({ sessionId: 'x2', restoring: true }));
  assert.equal(restored.env.CODEX_HOME, home(a));
});

test('used up until its reset, presumed reset after it, and an early reset frees the account at once', async (t) => {
  const { service, addSignedIn, homeLimits, home, context, now, advance, emitted } = await fixture(t);
  const a = await addSignedIn('grok', 'Grok A');
  const resetAt = now() + 5 * 60 * MIN;
  homeLimits.set(home(a), available('grok', now(), [windowOf('weekly', 100, resetAt, 10080)]));
  await service.poolCheck(a);
  assert.match((await service.prepare(context({ provider: 'grok', sessionId: 'g1', options: { account: 'pool:grok' } }))).refuse.reason, /used up/);
  // A subagent naming it is refused; the person may still start it (warned in the log).
  assert.match((await service.prepare(context({ provider: 'grok', sessionId: 'g2', role: 'subagent', options: { account: `sub:${a}` } }))).refuse.reason, /omit the account/);
  // The provider resets early: used share drops before the announced time.
  advance(30 * MIN);
  homeLimits.set(home(a), available('grok', now(), [windowOf('weekly', 3, resetAt, 10080)]));
  await service.poolCheck(a);
  const events = service.pools.view().providers.find(entry => entry.provider === 'grok').accounts[0].events;
  assert.ok(events.some(event => event.kind === 'early-reset'), JSON.stringify(events));
  assert.ok(emitted.some(entry => entry.event === 'quota' && entry.data.kind === 'early-reset'));
  const ok = await service.prepare(context({ provider: 'grok', sessionId: 'g3', options: { account: 'pool:grok' } }));
  assert.equal(ok.env.GROK_HOME, home(a));
  // CanvasTTY's own notification for the home is taken as a read too.
  service.pools.sessionEvent({ type: 'exited', session: { id: 'g3' } });
  advance(10 * MIN);
  service.pools.limitsChanged({ provider: 'grok', home: home(a), ...available('grok', now(), [windowOf('weekly', 100, resetAt + 7 * 1440 * MIN, 10080)]) });
  assert.match((await service.prepare(context({ provider: 'grok', sessionId: 'g4', options: { account: 'pool:grok' } }))).refuse.reason, /used up/);
});

test('signed out or expired homes are skipped; a CanvasTTY without per-home limits leaves quota unknown, never used up', async (t) => {
  const { service, addSignedIn, homeLimits, home, context, now } = await fixture(t);
  const a = await addSignedIn('claude', 'Claude A');
  const b = await addSignedIn('claude', 'Claude B');
  homeLimits.set(home(a), unavailable('claude', 'session-expired', now()));
  homeLimits.set(home(b), available('claude', now(), [windowOf('five_hour', 10, now() + 100 * MIN)]));
  await service.poolCheck(a); await service.poolCheck(b);
  const answer = await service.prepare(context({ provider: 'claude', sessionId: 'c1', options: { account: 'pool:claude' } }));
  assert.equal(answer.env.CLAUDE_CONFIG_DIR, home(b));
  const routes = (await service.tool('list_routes', { provider: 'claude' })).content.routes;
  assert.deepEqual(routes.map(row => [row.accountId, row.state]), [[a, 'signed-out'], [b, 'busy']]);

  const old = await fixture(t, { limits: 'missing' });
  const x = await old.addSignedIn('grok', 'Grok X');
  const view = old.service.pools.view();
  assert.equal(view.limits, 'no');
  const member = view.providers.find(entry => entry.provider === 'grok').accounts.find(entry => entry.id === x);
  assert.equal(member.quota.state, 'unknown');
  assert.match(member.limitsNote, /cannot read quotas for account homes/);
  assert.equal((await old.service.prepare(old.context({ provider: 'grok', sessionId: 'z', options: { account: 'pool:grok' } }))).env.GROK_HOME, old.home(x));
});

test('CanvasTTY\'s 32-home bound is said, not hidden; the plugin itself caps nothing', async (t) => {
  const { service, addSignedIn, homeLimits, home } = await fixture(t);
  const id = await addSignedIn('grok', 'Grok 33');
  homeLimits.set(home(id), new Error(`A plugin can read limits for at most ${CORE_HOME_LIMIT} account homes.`));
  await service.poolCheck(id);
  const member = service.pools.view().providers.find(entry => entry.provider === 'grok').accounts[0];
  assert.match(member.limitsNote, /at most 32 accounts per plugin/);
  assert.equal(member.quota.state, 'unknown');
  assert.equal(service.pools.view().homeLimit.limit, 32);
});

test('orchestrators: list_routes shows pool rows with quota and trust; pick_account prefers the pool and spreads parallel picks', async (t) => {
  const { service, addSignedIn, homeLimits, home, context, now } = await fixture(t);
  const a = await addSignedIn('grok', 'Grok A', 'D2');
  const b = await addSignedIn('grok', 'Grok B', 'D1');
  homeLimits.set(home(a), available('grok', now(), [windowOf('weekly', 10, now() + 1440 * MIN, 10080)]));
  homeLimits.set(home(b), available('grok', now(), [windowOf('weekly', 50, now() + 1440 * MIN, 10080)]));
  await service.poolCheck(a); await service.poolCheck(b);
  const listed = (await service.tool('list_routes', { provider: 'grok' })).content;
  assert.deepEqual(listed.routes.map(row => [row.accountId, row.kind, row.state, row.trust, row.quota.remainingPercent]), [[a, 'subscription', 'ready', 'D2', 90], [b, 'subscription', 'ready', 'D1', 50]]);
  assert.deepEqual(listed.routes[0].launchOptions, { 'canvastty-accounts': { account: `sub:${a}`, effort: 'default', trustFolder: false } });
  assert.match(listed.pools, /pool:<agent>/);
  const first = (await service.tool('pick_account', { provider: 'grok' })).content;
  const second = (await service.tool('pick_account', { provider: 'grok' })).content;
  assert.equal(first.accountId, a);
  assert.equal(second.accountId, b, 'a pick is reserved for a minute');
  assert.equal(first.kind, 'subscription');
  assert.deepEqual(first.spawn, { provider: 'grok', launchOptions: first.launchOptions });
  const none = await service.tool('pick_account', { provider: 'grok' });
  assert.equal(none.isError, true);
  assert.match(none.content, /2 a card already runs on it/);
  // The reserved launch itself is not refused by its own reservation.
  assert.equal((await service.prepare(context({ provider: 'grok', sessionId: 'p1', role: 'subagent', options: { account: `sub:${a}` } }))).env.GROK_HOME, home(a));
  // Strict data checks: only the account trusted with the task's class.
  service.pools.sessionEvent({ type: 'exited', session: { id: 'p1' } });
  const strict = await service.tool('list_routes', { provider: 'grok', dataClass: 'D2', dataClassMode: 'strict' });
  assert.deepEqual(strict.content.routes.map(row => [row.accountId, row.state]), [[a, 'ready'], [b, 'busy']]);
  assert.equal((await service.tool('pick_account', { provider: 'grok', dataClass: 'D9' })).isError, true);
  // Effort per launch reaches the pool account's CLI.
  service.pools.sessionEvent({ type: 'exited', session: { id: 'none' } });
  assert.deepEqual(service.launchOptions('grok').account.map(option => option.value), ['pool:grok', `sub:${a}`, `sub:${b}`]);
});

test('remove: refused while a card runs; then the account and its whole home are gone', async (t) => {
  const { service, addSignedIn, home, context, storage } = await fixture(t);
  const a = await addSignedIn('kimi', 'Kimi A');
  const answer = await service.prepare(context({ provider: 'kimi', sessionId: 'k1', options: { account: `sub:${a}` } }));
  assert.equal(answer.env.KIMI_CODE_HOME, home(a));
  await assert.rejects(service.poolRemove(a), /still runs/);
  service.pools.sessionEvent({ type: 'closed', session: { id: 'k1' } });
  await service.poolRemove(a);
  assert.equal(existsSync(home(a)), false);
  assert.deepEqual(storage.pools.accounts, []);
  assert.match((await service.prepare(context({ provider: 'kimi', sessionId: 'k2', options: { account: `sub:${a}` } }))).refuse.reason, /no longer exists/);
});

test('pool launches stay on this computer and refuse a server environment', async (t) => {
  const { service, addSignedIn, context } = await fixture(t);
  await addSignedIn('grok', 'Grok A');
  const refused = await service.prepare(context({ provider: 'grok', sessionId: 'e1', environment: { pluginId: 'canvastty-environments', kind: 'ssh' }, options: { account: 'pool:grok' } }));
  assert.match(refused.refuse.reason, /this computer only/);
  const worktree = await service.prepare(context({ provider: 'grok', sessionId: 'e2', environment: { pluginId: 'canvastty-environments', kind: 'worktree' }, options: { account: 'pool:grok' } }));
  assert.ok(worktree.env.GROK_HOME);
});

test('no credential, token or e-mail ever leaves a home: state, routes, picks, logs, events, saved files', async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (const provider of ['claude', 'codex', 'grok', 'kimi']) ids.push(await f.addSignedIn(provider, `${provider} secretless`));
  f.homeLimits.set(f.home(ids[2]), available('grok', f.now(), [windowOf('weekly', 40, f.now() + 1440 * MIN, 10080)]));
  await f.service.poolCheck(ids[2]);
  const outputs = [
    JSON.stringify(await f.service.state()),
    JSON.stringify(await f.service.tool('list_routes', {})),
    JSON.stringify(await f.service.tool('pick_account', { provider: 'grok' })),
    JSON.stringify(await f.service.prepare(f.context({ provider: 'claude', sessionId: 'n1', options: { account: 'pool:claude' } }))),
    JSON.stringify(f.logs), JSON.stringify(f.emitted), JSON.stringify(f.storage), JSON.stringify(f.created)
  ];
  await f.service.pools.flush();
  for (const name of await readdir(f.dataDir)) if (name.endsWith('.json')) outputs.push(await readFile(join(f.dataDir, name), 'utf8'));
  for (const text of outputs) for (const secret of [TOKEN, ACCESS, EMAIL]) assert.ok(!text.includes(secret), `a fixture secret leaked: ${text.slice(0, 120)}`);
  // The homes do hold them (the fake CLIs wrote them there): the probe never reads a credential file.
  assert.ok((await readFile(join(f.home(ids[1]), 'auth.json'), 'utf8')).includes(TOKEN));
});

test('limits.get answers: windows mapped per provider; another bucket never blocks; reasons mapped', () => {
  const at = Date.parse('2026-10-21T10:00:00Z');
  const ok = limitsObservation('codex', available('codex', at, [windowOf('primary', 30, at + MIN), windowOf('spark', 100, at + MIN, 300, { isDefaultBucket: false })]));
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(ok.windows.map(window => [window.id, window.label, window.models]), [['codex:primary', '5h', true], ['codex:spark', '5h', false]]);
  assert.equal(limitsObservation('claude', unavailable('claude', 'not-authenticated', at)).kind, 'signed-out');
  assert.equal(limitsObservation('claude', unavailable('claude', 'session-expired', at)).kind, 'expired');
  assert.equal(limitsObservation('kimi', unavailable('kimi', 'unsupported-protocol', at)).kind, 'unsupported');
  assert.equal(limitsObservation('grok', { state: 'ready', snapshot: { fetchedAt: at, providers: [] } }).kind, 'failed');
});

test('without card events the one-card rule cannot hold, and the plugin says so instead of locking accounts forever', async (t) => {
  const { service, addSignedIn, context, home } = await fixture(t, { events: false });
  const a = await addSignedIn('grok', 'Grok A');
  assert.equal(service.pools.view().cardEvents, false);
  assert.equal((await service.prepare(context({ provider: 'grok', sessionId: 'w1', options: { account: 'pool:grok' } }))).env.GROK_HOME, home(a));
  assert.equal((await service.prepare(context({ provider: 'grok', sessionId: 'w2', options: { account: 'pool:grok' } }))).env.GROK_HOME, home(a));
});

test('model accounts and pool accounts never share an id', async (t) => {
  const { service } = await fixture(t);
  const added = await service.poolAdd({ provider: 'grok', label: 'x', trust: 'D0' });
  await assert.rejects(service.save({ version: 1, accounts: [{ id: added.id, label: 'Clash', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude'] }] }), /already the name of a pool account/);
});

// The bundled settings page (settings/accounts.js) in a minimal fake DOM, talking to a real AccountsService through a
// fake CanvasTTY host: one service-event listener however often the page saves, and quick add as the person sees it
// (provider tile, key, «Добавить»; the data class asked once inline and then remembered; the region the key answered
// on; the staged key removed afterwards). The network is a fixture; every key is assembled at runtime.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService } from '../src/service/accounts.ts';
import { loadPage, settle } from './helpers/fake-dom.mjs';

const PAGE = new URL('../settings/accounts.js', import.meta.url).pathname;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const KEY = ['plan', 'page', 'fixture', 'beef'.repeat(6)].join('.');
const zaiUsed = percent => ({ code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: percent, nextResetTime: NOW + 3_600_000 }], level: 'pro' } });

async function setup(t, { answers = () => ({ status: 401, body: {} }), locale = 'ru' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-page-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const storage = {};
  const secrets = {};
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    const next = answers(url);
    return { status: next.status ?? 200, text: async () => JSON.stringify(next.body) };
  };
  const serviceHost = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return structuredClone(storage[params.key] ?? null);
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'secrets.get') return secrets[params.key] ?? null;
      if (method === 'sessions.subscribe') return { sessions: [] };
      throw new Error(`host: ${method} not allowed`);
    },
    log: () => undefined,
    emit: () => undefined
  };
  const service = new AccountsService({ host: serviceHost, dataDir, quotaFetch: fetch, modelsFetch: fetch, now: () => NOW, random: () => 0.5 });
  await service.pools.start();
  t.after(() => service.pools.stop());
  const methods = {
    state: () => service.state(), save: params => service.save(params.settings), keyChanged: params => service.keyChanged(params.accountId),
    planQuickAdd: params => service.planQuickAdd(params), setDefaults: params => service.setDefaults(params), planRegion: params => service.planRegion(params),
    poolAdd: params => service.poolAdd(params), check: params => service.check(params.accountId)
  };
  const listeners = new Set();
  const counts = { onEvent: 0, requests: {} };
  const host = {
    onContext: listener => { listener({ appearance: { locale } }); return () => undefined; },
    secrets: {
      set: async (key, value) => { secrets[key] = value; },
      delete: async key => { delete secrets[key]; }
    },
    service: {
      // The page sees JSON, as through CanvasTTY's bridge.
      request: async (serviceId, method, params) => {
        assert.equal(serviceId, 'accounts');
        counts.requests[method] = (counts.requests[method] ?? 0) + 1;
        if (!methods[method]) throw new Error(`no method ${method}`);
        return JSON.parse(JSON.stringify(await methods[method](params ?? {}) ?? null));
      },
      onEvent: listener => { counts.onEvent++; listeners.add(listener); return () => listeners.delete(listener); }
    }
  };
  const page = loadPage(PAGE, host);
  await settle();
  return { ...page, service, storage, secrets, calls, counts, listeners, emit: event => { for (const listener of listeners) listener(event); } };
}

test('page: one service-event listener for the page\'s lifetime, however many saves (the listeners no longer pile up)', async (t) => {
  const page = await setup(t, { locale: 'en' });
  assert.equal(page.counts.onEvent, 1);
  const SAVES = 6;
  for (let i = 0; i < SAVES; i++) {
    await page.app.named('add').dispatch('click');
    await settle();
  }
  assert.equal(page.service.settings.accounts.length, SAVES, 'each click saved an account');
  const id = page.service.settings.accounts[0].id;
  for (let i = 0; i < SAVES; i++) {
    await page.app.named(`save-${id}`).dispatch('click');
    await settle();
  }
  assert.equal(page.counts.requests.save, 2 * SAVES);
  assert.equal(page.counts.onEvent, 1, 'no listener was added by a save');
  assert.equal(page.listeners.size, 1);
  // One event reloads the page once (not once per save made so far).
  const loads = page.counts.requests.state;
  page.emit({ event: 'quota' });
  await settle();
  assert.equal(page.counts.requests.state, loads + 1);
});

test('page: quick add — tile, key, «Добавить»; the data class is asked once inline, then remembered; the region is shown', async (t) => {
  const page = await setup(t, { answers: url => url.startsWith('https://open.bigmodel.cn/') ? { body: zaiUsed(25) } : { status: 401, body: {} } });
  assert.ok(page.app.named('tile-glm'), 'a GLM tile');
  assert.ok(page.app.named('tile-minimax'), 'a MiniMax tile');
  assert.ok(page.app.named('tile-claude'), 'a sign-in tile');
  assert.equal(page.app.named('plan-new-key-glm'), null, 'the old six-field form is gone');
  await page.app.named('tile-glm').dispatch('click');
  await settle();
  const ask = page.app.find(node => node.dataset.dataDefault === 'ask');
  assert.ok(ask, 'the data class is asked inline while no default is set');
  const advanced = page.app.find(node => node.tagName === 'DETAILS' && node.dataset.advanced === 'glm');
  assert.ok(advanced && !advanced.open, '«Дополнительно» is collapsed');
  assert.ok(advanced.named('quick-region-glm') && advanced.named('quick-concurrency-glm').value === '2' && advanced.named('quick-auto-glm').checked === true);
  // Without an answer nothing is sent.
  page.app.named('quick-key-glm').value = KEY;
  await page.app.named('quick-add-glm').dispatch('click');
  await settle();
  assert.match(page.status.textContent, /один раз/u);
  assert.equal(page.calls.length, 0);
  assert.equal(page.service.settings.accounts.length, 0);
  // The person answers D1 and adds.
  const d1 = ask.find(node => node.name === 'data-default' && node.value === 'D1');
  d1.checked = true;
  await d1.dispatch('change');
  page.app.named('quick-key-glm').value = KEY;
  await page.app.named('quick-add-glm').dispatch('click');
  await settle();
  assert.match(page.status.textContent, /Найден регион: BigModel \(Китай\) — ключ ответил на open\.bigmodel\.cn/u);
  assert.match(page.status.textContent, /Assistant ещё не читал/u, 'the one-line note: Auto cannot be told');
  const [account] = page.service.settings.accounts;
  assert.equal(account.label, 'GLM 1');
  assert.equal(account.trust, 'D1');
  assert.equal(account.brokerable, true);
  assert.equal(new URL(account.baseUrl).host, 'open.bigmodel.cn');
  assert.equal(page.secrets[`key.${account.id}`], KEY);
  assert.equal(page.secrets['probe.glm'], undefined, 'the staged key is removed');
  assert.equal(page.storage.defaults.dataClass, 'D1');
  // The next add is not asked again; the default is shown as the page's setting.
  await page.app.named('tile-glm').dispatch('click');
  await settle();
  assert.equal(page.app.find(node => node.dataset.dataDefault === 'ask'), null);
  const setting = page.app.find(node => node.dataset.dataDefault === 'D1');
  assert.ok(setting && /Класс данных для новых аккаунтов/u.test(setting.textContent));
  assert.ok(page.app.named(`plan-region-${account.id}`), 'the person can move the account to the other region');
});

test('page: a key no host takes — the error names both hosts, nothing is saved, the staged key is removed', async (t) => {
  const page = await setup(t);
  await page.service.setDefaults({ dataClass: 'D0' });
  page.emit({ event: 'quota' });
  await settle();
  await page.app.named('tile-glm').dispatch('click');
  await settle();
  page.app.named('quick-key-glm').value = KEY;
  await page.app.named('quick-add-glm').dispatch('click');
  await settle();
  assert.match(page.status.textContent, /Ключ не подошёл ни к api\.z\.ai, ни к open\.bigmodel\.cn\. Ничего не сохранено\./u);
  assert.equal(page.service.settings.accounts.length, 0);
  assert.deepEqual(Object.keys(page.secrets), []);
});

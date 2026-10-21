// Brokered requests (CanvasTTY B6) from the Accounts side: which accounts are offered, how a request is admitted
// against the account's quota, and what settling does. Against a fake host; nothing leaves this process.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountsService } from '../src/service/accounts.ts';
import { brokerOfferOf, validateAccount } from '../src/shared/accounts.ts';

const KEY = ['sk', 'fixture', 'broker', 'c0ffee00'.repeat(4)].join('-');

async function fixture(t, accounts) {
  const dataDir = await mkdtemp(join(tmpdir(), 'canvastty-accounts-broker-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
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
  await service.save({ version: 1, accounts });
  const setKey = async (id) => { secrets[`key.${id}`] = KEY; await service.keyChanged(id); };
  return { service, storage, secrets, logs, setKey };
}

const glmPlan = { id: 'glm-plan', label: 'GLM plan', preset: 'zai-anthropic', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6', agents: ['claude', 'opencode'] };
const glmOpenAi = { id: 'glm-oai', label: 'GLM OpenAI', preset: 'zai-openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6', agents: ['opencode'] };
const local = { id: 'qwen-local', label: 'Qwen local', preset: 'ollama-local', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', agents: ['opencode'] };
const openrouter = { id: 'or', label: 'OpenRouter', preset: 'openrouter-openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-4.6', agents: ['opencode'] };

test('validation: brokerable is off unless ticked, and never for Ollama or OpenRouter accounts', () => {
  assert.equal(validateAccount(glmPlan).brokerable, undefined);
  assert.equal(validateAccount({ ...glmPlan, brokerable: false }).brokerable, undefined);
  assert.equal(validateAccount({ ...glmPlan, brokerable: true }).brokerable, true);
  assert.throws(() => validateAccount({ ...glmPlan, brokerable: 'yes' }), /true or false/);
  assert.throws(() => validateAccount({ ...local, brokerable: true }), /API account with a key/);
  // A key goes over https only: an API on this computer (plain http) cannot be offered.
  assert.throws(() => validateAccount({ ...glmOpenAi, preset: 'custom-openai', baseUrl: 'http://127.0.0.1:8080/v1', brokerable: true }), /https API account/);
  assert.throws(() => validateAccount({ ...openrouter, brokerable: true }), /OpenRouter is for Jev/);
  assert.throws(() => validateAccount({ ...glmOpenAi, preset: 'custom-openai', baseUrl: 'https://eu.openrouter.ai/api/v1', brokerable: true }), /OpenRouter is for Jev/);
});

test('offers: the Anthropic endpoint as Claude Code calls it, the OpenAI one with its paths; one model; never a key', () => {
  assert.deepEqual(brokerOfferOf({ ...glmPlan, brokerable: true }, true), {
    id: 'glm-plan', label: 'GLM plan', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic/v1', paths: ['/messages'],
    models: ['glm-4.6'], secretKey: 'key.glm-plan', auth: 'bearer', flatRate: true
  });
  assert.deepEqual(brokerOfferOf({ ...glmOpenAi, brokerable: true, responsesApi: true }, false).paths, ['/chat/completions', '/responses', '/models']);
  assert.equal(brokerOfferOf(glmPlan, true), null, 'not marked');
});

test('the service offers only marked accounts whose key is saved for their current address', async (t) => {
  const { service, setKey, secrets } = await fixture(t, [{ ...glmPlan, brokerable: true }, glmOpenAi, local]);
  assert.deepEqual(service.brokerOffer(), [], 'no key yet');
  await setKey('glm-plan');
  await setKey('glm-oai');
  const offers = service.brokerOffer();
  assert.deepEqual(offers.map((offer) => [offer.id, offer.flatRate]), [['glm-plan', true]], 'only the marked one; a Z.AI plan is flat-rate');
  assert.ok(!JSON.stringify(offers).includes(KEY));
  // Moving the account to another address unbinds its key: it is not offered until the key is saved again.
  await service.save({ version: 1, accounts: [{ ...glmPlan, brokerable: true, baseUrl: 'https://open.bigmodel.cn/api/anthropic' }, glmOpenAi, local] });
  assert.deepEqual(service.brokerOffer(), []);
  await setKey('glm-plan');
  assert.equal(service.brokerOffer()[0].baseUrl, 'https://open.bigmodel.cn/api/anthropic/v1');
  // Unticking it ends the offer.
  await service.save({ version: 1, accounts: [{ ...glmPlan, baseUrl: 'https://open.bigmodel.cn/api/anthropic' }, glmOpenAi, local] });
  assert.deepEqual(service.brokerOffer(), []);
  void secrets;
});

test('admit: refused for an account not offered, another model, or a used-up plan; settle counts the use', async (t) => {
  const { service, setKey, logs } = await fixture(t, [{ ...glmPlan, brokerable: true }, glmOpenAi]);
  await setKey('glm-plan');
  await setKey('glm-oai');
  const caller = { pluginId: 'canvastty-assistant' };
  assert.deepEqual(service.brokerAdmit({ ref: 'glm-plan', caller, model: 'glm-4.6', estimate: { bodyBytes: 10 } }), { ok: true });
  assert.equal(service.brokerAdmit({ ref: 'glm-oai', caller, model: 'glm-4.6' }).ok, false, 'not marked');
  assert.equal(service.brokerAdmit({ ref: 'missing', caller, model: 'glm-4.6' }).ok, false);
  assert.match(service.brokerAdmit({ ref: 'glm-plan', caller, model: 'glm-5' }).reason, /runs glm-4\.6 only/);
  // A Z.AI limit error seen elsewhere (code 1308 = plan used up) makes the account exhausted.
  const account = service.settings.accounts.find((entry) => entry.id === 'glm-plan');
  service.quota.noteLimit(account, { source: 'zai-limit-error', at: Date.now(), windows: [], exhausted: { until: Date.now() + 3_600_000, code: '1308' } });
  const refused = service.brokerAdmit({ ref: 'glm-plan', caller, model: 'glm-4.6' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /plan quota used up until/);
  assert.ok(logs.some((line) => /refused, the plan is used up/.test(line.message)));
  assert.equal(service.brokerSettle({ ref: 'glm-plan', caller, model: 'glm-4.6', status: 'ok', httpStatus: 200, usage: { input: 1, output: 1, cached: 0 } }), null);
  assert.equal(service.brokerSettle({ ref: 'nope', status: 'ok' }), null);
  await service.quota.stop?.();
});

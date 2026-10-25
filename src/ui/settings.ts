// The Accounts settings page (bundled to settings/accounts.js). It runs in CanvasTTY's sandboxed plugin frame (no
// forms: buttons only): accounts go through the service, which validates and stores them; keys are written straight
// into the plugin's secrets after a local format check and are never read back — the page only learns whether one
// exists and for which address it was saved.
import { apiKeyProblem } from '../shared/apiKeyHygiene.ts';
import {
  HARNESS_LABELS, HARNESSES, PRESETS, accountKeyed, brokerableShape, harnessSupport, newAccountId, secretKeyOf,
  type Account, type AccountsSettings, type Harness, type PresetId
} from '../shared/accounts.ts';
import type { AccountDefaults, CheckResult, ModelNotice, PlansView, QuickAddResult } from '../service/accounts.ts';
import type { DataClass } from '../pools/model.ts';
import { BUNDLED_CHECKED, sortModels, type PlanModelList } from '../plans/models.ts';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, PLAN_INFO, planOf, type PlanProvider, type PlanRegion } from '../plans/plans.ts';
import type { PoolsView, PoolMemberView } from '../pools/service.ts';
import { quotaShareText } from '../shared/quotaText.ts';

interface PluginHost {
  onContext(listener: (context: { appearance: { locale: 'ru' | 'en' } }) => void): void;
  secrets: { set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  service: { request(serviceId: string, method: string, params?: unknown): Promise<unknown>; onEvent?(listener: (event: { event?: string }) => void): () => void };
}
interface State {
  settings: AccountsSettings;
  keys: Record<string, 'ok' | 'missing' | 'other-address' | 'none'>;
  checks: Record<string, CheckResult | { error: string }>;
  quota?: Record<string, QuotaLine>;
  pools?: PoolsView;
  plans?: PlansView;
  models?: Record<string, PlanModelList>;
  modelNotices?: ModelNotice[];
  defaults?: AccountDefaults;
}
interface QuotaLine {
  state: 'ok' | 'low' | 'exhausted' | 'presumed-reset' | 'unknown' | 'stale';
  remainingPercent: number | null; window: string | null; resetsAt: string | null; ageMinutes: number | null;
  confidence: 'exact' | 'estimated' | 'none'; readable: boolean; events: Array<{ at: number; kind: string; note: string }>;
}

const host = (window as unknown as { CanvasTTYPlugin: PluginHost }).CanvasTTYPlugin;
const SERVICE = 'accounts';

const STRINGS = {
  en: {
    title: 'Model accounts',
    lead: 'Run Claude Code, Codex, OpenCode, Qwen Code or Kimi on another model: a local Ollama model, Ollama Cloud, Z.AI, MiniMax, OpenRouter or any compatible API. An account is used only when you choose it in the launcher (Advanced → Use CanvasTTY Accounts → Model account) or an orchestrator passes it to a subagent; the agents\' own sign-ins stay untouched, and nothing is written to ~/.claude, ~/.codex or ~/.ollama. GLM and MiniMax Coding Plans are under Subscription accounts.',
    none: 'No accounts yet.', add: 'Add account', provider: 'Provider', name: 'Name', address: 'Address', model: 'Model',
    responses: 'The endpoint has the OpenAI Responses API (needed for Codex)', agents: 'Agents',
    brokerable: 'Other extensions may send model requests through this account (CanvasTTY adds the key; they never see it). Allow each extension under Settings → Agents → Extension native code → Accounts. Check that the plan\'s terms allow it.',
    saveChanges: 'Save changes', remove: 'Remove', check: 'Check', checking: 'Checking…',
    key: 'API key', keyOk: 'key saved', keyMissing: 'no key', keyOther: 'key saved for another address — save it again', saveKey: 'Save key', removeKey: 'Remove key',
    keyWriteOnly: 'Keys are write-only: they are kept in CanvasTTY\'s encrypted plugin secrets and handed to the agent by CanvasTTY.',
    saved: 'Saved.', notSaved: 'Not saved: ', keySaved: 'Key saved.', keyRemoved: 'Key removed.',
    ollamaDown: 'Ollama is not running at this address. Open Ollama or run `ollama serve`.', notOllama: 'This address does not answer like Ollama.',
    ollamaOk: (version: string | null, count: number) => `Ollama ${version ?? ''} is running: ${count} model(s).`,
    modelOk: 'The model is installed and can call tools.', modelMissing: 'The model is not installed here; pull it yourself or choose one below.',
    modelNoTools: 'The model cannot call tools, so it cannot drive an agent.', use: 'Use', tools: 'tools', cloud: 'cloud',
    keyCheckOk: 'The key looks right (format only; nothing was sent to the provider).',
    keyCheckFail: (problem: string) => `Key: ${problem}`,
    quota: 'Quota', readNow: 'Read now',
    quotaState: { ok: 'room left', low: 'running low', exhausted: 'used up', 'presumed-reset': 'probably reset (reading again)', unknown: 'unknown', stale: 'unknown (old read)' } as Record<string, string>,
    left: (percent: number, window: string | null) => quotaShareText('en', percent, window),
    resets: (time: string) => `resets ${time}`,
    age: (minutes: number | null) => minutes === null ? 'not read yet' : minutes < 1 ? 'read just now' : `read ${minutes} min ago`,
    passive: 'Only limit messages are seen for this provider; its quota is not read.',
    earlyReset: 'early reset',
    pools: 'Subscription accounts',
    poolsLead: 'Your own sign-ins, several per agent. Each account gets its own folder inside this plugin; you sign in once in the agent\'s own sign-in (browser, password or Google) — CanvasTTY never sees the password. Launch on "<agent> pool" to get the account with the most quota left. One card per account at a time, and accounts stay on this computer.',
    poolAccounts: (count: number) => `${count} account(s)`, poolNone: 'No accounts yet.',
    poolAdd: 'Add account', poolTrust: 'Trust with data up to', trustUnset: 'Not set (decide later)', poolChooseTrust: 'Choose how far you trust this account first.',
    signIn: 'Sign in', signInAgain: 'Sign in again', poolCheck: 'Check', poolSignInOpened: 'A card with the sign-in opened on the canvas.',
    signState: { 'signed-in': 'signed in', 'signed-out': 'not signed in', expired: 'sign-in expired', unknown: 'sign-in unknown' } as Record<string, string>,
    signingIn: 'signing in…', running: (count: number) => `${count} card running`, lastUsed: (time: string) => `last used ${time}`, neverUsed: 'not used yet',
    poolLimitsNo: 'This CanvasTTY cannot read quotas for these accounts; they are picked as "unknown" (never as used up).',
    poolHomeLimit: (limit: number) => `CanvasTTY reads quotas for at most ${limit} accounts per plugin; the others stay "unknown". You can still add and use them.`,
    poolNoEvents: 'CanvasTTY sends this plugin no card events, so "one card per account" cannot be checked.',
    poolRemoveNote: 'Removing deletes the account\'s folder with its sign-in. Claude Code on macOS keeps its sign-in in the Keychain: type /logout in a card on the account first if you want that gone too.',
    notPooled: 'Not available as pools:',
    plansLead: 'Coding plans sign in with an API key: paste the plan\'s key once. It is stored in CanvasTTY\'s encrypted plugin secrets, sent only to the plan\'s own host, and several cards may run on one account at once. Launch Claude Code or OpenCode on "<plan> pool" to get the account with the most quota left.',
    region: 'Region', concurrency: 'Cards at once', forAuto: 'For Auto and other extensions (CanvasTTY adds the key; they never see it)',
    planAdd: 'Add subscription', planKeyFirst: 'Paste the plan\'s API key first.', planHost: (host: string) => `key sent only to ${host}`,
    planRunning: (running: number, cap: number) => `${running} of ${cap} cards running`,
    mainModel: 'Model', smallModel: 'Small model (Claude Code\'s Haiku slot, OpenCode\'s titles)',
    newest: (id: string) => `Newest on the plan's list (now ${id})`, notListed: 'not on the plan\'s list',
    listLive: (host: string, age: string) => `Models: the plan's own list from ${host}, ${age}; read again daily and with Read now.`,
    listBundled: (checked: string) => `Models: the plugin's built-in list (checked ${checked}) until the plan's own list is read.`,
    listAge: (minutes: number) => minutes < 1 ? 'read just now' : minutes < 120 ? `read ${minutes} min ago` : `read ${Math.round(minutes / 60)} h ago`,
    modelsMoved: 'Plan accounts moved to newer models',
    modelMoved: (notice: ModelNotice) => `${notice.label}: ${notice.from.model} → ${notice.to.model}${notice.from.smallModel !== notice.to.smallModel ? `, small ${notice.from.smallModel} → ${notice.to.smallModel}` : ''}`
      + (notice.reason === 'older' ? ' (the old model is older than every model the plan lists now).' : ' (a newer model is on the plan\'s list).'),
    modelsMovedWhy: 'No model was chosen for these accounts (or the plugin cannot tell whether one was), so they follow the plan\'s list. Choose a model on the account to keep it.',
    ok: 'OK',
    quickAdd: 'Add a subscription', quickLead: 'Choose the provider and paste the key: the region, name and limits are filled in; change them under «Advanced».',
    tileSignIn: (label: string) => `${label} (sign-in)`, advanced: 'Advanced', regionAuto: 'Find it from the key',
    dataDefault: 'Data class for new accounts', dataAsk: 'Trust new accounts with data up to (asked once, remembered):',
    dataChooseFirst: 'Choose how far you trust new accounts with data first (asked once).',
    dataOff: 'Data classes are off (the Assistant\'s data-check mode is Off): new accounts are added without asking.',
    autoNote: '«For Auto» is on by default; the Assistant has not read these accounts yet, so Accounts cannot tell whether Auto is set up.',
    grantNote: 'The Assistant may use a new account once it is allowed under Settings → Agents.',
    findingRegion: 'Checking the key with the plan\'s quota read (no model request)…',
    found: (region: string, host: string) => `Added. Region found: ${region} — the key answered on ${host}.`,
    signInAdd: 'Add and sign in', moveRegion: (label: string) => `Move to ${label}`,
    moveRegionNote: (host: string) => `the account and its saved key go to ${host}`,
    moved: (host: string) => `Moved; the key is now sent only to ${host}.`,
    quickFail: {
      'key-refused': (hosts: string[]) => hosts.length > 1 ? `The key did not work on ${hosts.join(' or ')}. Nothing was saved.` : `The key did not work on ${hosts[0] ?? ''}. Nothing was saved.`,
      unreachable: (host: string) => `${host} did not answer, so the key could not be checked. Nothing was saved; try again or choose the region under «Advanced».`,
      error: (host: string, status: number | null) => `${host} answered ${status === null ? 'in an unknown way' : `HTTP ${status}`}. Nothing was saved; try again or choose the region under «Advanced».`,
      'pay-as-you-go': 'This is a MiniMax pay-as-you-go key (sk-api-…), not a Coding Plan key: it has no plan quota. Add it as a model account (MiniMax preset) above. Nothing was sent.',
      busy: 'A key of this plan is being checked already.', budget: 'Too many checks this hour; try later or choose the region under «Advanced».'
    }
  },
  ru: {
    title: 'Учётные записи моделей',
    lead: 'Запускайте Claude Code, Codex, OpenCode, Qwen Code или Kimi на другой модели: локальной в Ollama, в Ollama Cloud, Z.AI, MiniMax, OpenRouter или любом совместимом API. Учётная запись используется, только когда вы выбрали её в окне запуска (Дополнительно → Use CanvasTTY Accounts → Model account) или оркестратор передал её субагенту; собственные входы агентов не меняются, в ~/.claude, ~/.codex и ~/.ollama ничего не пишется. Тарифы GLM и MiniMax Coding Plan — в разделе «Учётные записи подписок».',
    none: 'Пока нет учётных записей.', add: 'Добавить', provider: 'Провайдер', name: 'Название', address: 'Адрес', model: 'Модель',
    responses: 'У адреса есть OpenAI Responses API (нужен для Codex)', agents: 'Агенты',
    brokerable: 'Другие расширения могут отправлять запросы к модели через эту учётную запись (ключ подставляет CanvasTTY, они его не видят). Каждое расширение разрешается в Настройки → Агенты → Нативный код расширений → Accounts. Проверьте, что условия тарифа это допускают.',
    saveChanges: 'Сохранить изменения', remove: 'Удалить', check: 'Проверить', checking: 'Проверяю…',
    key: 'API-ключ', keyOk: 'ключ сохранён', keyMissing: 'нет ключа', keyOther: 'ключ сохранён для другого адреса — сохраните заново', saveKey: 'Сохранить ключ', removeKey: 'Удалить ключ',
    keyWriteOnly: 'Ключи только записываются: они хранятся в зашифрованных секретах плагина, и агенту их передаёт сам CanvasTTY.',
    saved: 'Сохранено.', notSaved: 'Не сохранено: ', keySaved: 'Ключ сохранён.', keyRemoved: 'Ключ удалён.',
    ollamaDown: 'Ollama не запущена по этому адресу. Откройте Ollama или выполните `ollama serve`.', notOllama: 'Этот адрес отвечает не как Ollama.',
    ollamaOk: (version: string | null, count: number) => `Ollama ${version ?? ''} работает: моделей ${count}.`,
    modelOk: 'Модель установлена и умеет вызывать инструменты.', modelMissing: 'Модель здесь не установлена; скачайте её сами или выберите ниже.',
    modelNoTools: 'Модель не умеет вызывать инструменты и не может вести агента.', use: 'Выбрать', tools: 'инструменты', cloud: 'облако',
    keyCheckOk: 'Ключ выглядит верно (проверен только формат; провайдеру ничего не отправлялось).',
    keyCheckFail: (problem: string) => `Ключ: ${problem}`,
    quota: 'Квота', readNow: 'Прочитать сейчас',
    quotaState: { ok: 'есть запас', low: 'заканчивается', exhausted: 'исчерпана', 'presumed-reset': 'вероятно, сброшена (читаю заново)', unknown: 'неизвестна', stale: 'неизвестна (давнее чтение)' } as Record<string, string>,
    left: (percent: number, window: string | null) => quotaShareText('ru', percent, window),
    resets: (time: string) => `сброс ${time}`,
    age: (minutes: number | null) => minutes === null ? 'ещё не прочитана' : minutes < 1 ? 'прочитана только что' : `прочитана ${minutes} мин назад`,
    passive: 'У этого провайдера видны только сообщения о лимите; квота не читается.',
    earlyReset: 'досрочный сброс',
    pools: 'Учётные записи подписок',
    poolsLead: 'Ваши собственные входы, по нескольку на агента. У каждой учётной записи своя папка внутри этого плагина; вы входите один раз через вход самого агента (браузер, пароль или Google) — CanvasTTY пароль не видит. Запуск на «пуле <агента>» берёт учётную запись с наибольшим остатком квоты. Одна карточка на учётную запись одновременно; учётные записи остаются на этом компьютере.',
    poolAccounts: (count: number) => `учётных записей: ${count}`, poolNone: 'Пока нет учётных записей.',
    poolAdd: 'Добавить', poolTrust: 'Доверяю данные до', trustUnset: 'Не задано (решу позже)', poolChooseTrust: 'Сначала выберите, насколько вы доверяете этой учётной записи.',
    signIn: 'Войти', signInAgain: 'Войти заново', poolCheck: 'Проверить', poolSignInOpened: 'На холсте открылась карточка со входом.',
    signState: { 'signed-in': 'вход выполнен', 'signed-out': 'вход не выполнен', expired: 'вход истёк', unknown: 'вход неизвестен' } as Record<string, string>,
    signingIn: 'идёт вход…', running: (count: number) => `запущено карточек: ${count}`, lastUsed: (time: string) => `использовалась ${time}`, neverUsed: 'ещё не использовалась',
    poolLimitsNo: 'Этот CanvasTTY не умеет читать квоты этих учётных записей; они выбираются как «неизвестно» (но никогда как исчерпанные).',
    poolHomeLimit: (limit: number) => `CanvasTTY читает квоты не более чем ${limit} учётных записей на плагин; у остальных квота «неизвестна». Добавлять и использовать их можно.`,
    poolNoEvents: 'CanvasTTY не присылает плагину события карточек, поэтому правило «одна карточка на учётную запись» не проверяется.',
    poolRemoveNote: 'Удаление стирает папку учётной записи вместе со входом. Claude Code на macOS хранит вход в Связке ключей: чтобы убрать и его, сначала наберите /logout в карточке на этой учётной записи.',
    notPooled: 'Пулы недоступны:',
    plansLead: 'Тарифы для кодинга входят по API-ключу: вставьте ключ тарифа один раз. Он хранится в зашифрованных секретах плагина, отправляется только на хост самого тарифа, и на одной учётной записи можно запускать несколько карточек сразу. Запуск Claude Code или OpenCode на «пуле <тарифа>» берёт учётную запись с наибольшим остатком квоты.',
    region: 'Регион', concurrency: 'Карточек одновременно', forAuto: 'Для Auto и других расширений (ключ подставляет CanvasTTY, они его не видят)',
    planAdd: 'Добавить подписку', planKeyFirst: 'Сначала вставьте API-ключ тарифа.', planHost: (host: string) => `ключ отправляется только на ${host}`,
    planRunning: (running: number, cap: number) => `запущено карточек: ${running} из ${cap}`,
    mainModel: 'Модель', smallModel: 'Малая модель (слот Haiku в Claude Code, заголовки в OpenCode)',
    newest: (id: string) => `Самая новая из списка тарифа (сейчас ${id})`, notListed: 'нет в списке тарифа',
    listLive: (host: string, age: string) => `Модели: собственный список тарифа с ${host}, ${age}; читается заново раз в сутки и по «Прочитать сейчас».`,
    listBundled: (checked: string) => `Модели: встроенный список плагина (проверен ${checked}), пока не прочитан собственный список тарифа.`,
    listAge: (minutes: number) => minutes < 1 ? 'прочитан только что' : minutes < 120 ? `прочитан ${minutes} мин назад` : `прочитан ${Math.round(minutes / 60)} ч назад`,
    modelsMoved: 'Учётные записи тарифов переведены на более новые модели',
    modelMoved: (notice: ModelNotice) => `${notice.label}: ${notice.from.model} → ${notice.to.model}${notice.from.smallModel !== notice.to.smallModel ? `, малая ${notice.from.smallModel} → ${notice.to.smallModel}` : ''}`
      + (notice.reason === 'older' ? ' (старая модель старше всех моделей, которые тариф перечисляет сейчас).' : ' (в списке тарифа появилась более новая модель).'),
    modelsMovedWhy: 'Для этих учётных записей модель не выбиралась (или плагин не может это определить), поэтому они следуют списку тарифа. Чтобы оставить модель, выберите её в учётной записи.',
    ok: 'Понятно',
    quickAdd: 'Добавить подписку', quickLead: 'Выберите провайдера и вставьте ключ: регион, название и лимиты заполнятся сами; изменить их можно в «Дополнительно».',
    tileSignIn: (label: string) => `${label} (вход в аккаунт)`, advanced: 'Дополнительно', regionAuto: 'Определить по ключу',
    dataDefault: 'Класс данных для новых аккаунтов', dataAsk: 'Новым аккаунтам доверяю данные до (спрошу один раз и запомню):',
    dataChooseFirst: 'Сначала выберите, до какого класса доверять данные новым аккаунтам (спрашивается один раз).',
    dataOff: 'Классы данных выключены (режим проверки данных в Assistant — «Выкл.»): новые аккаунты добавляются без вопроса.',
    autoNote: '«Для Auto» включено по умолчанию; Assistant ещё не читал эти аккаунты, поэтому Accounts не видит, настроен ли Auto.',
    grantNote: 'Assistant сможет использовать новый аккаунт, когда он разрешён в Настройки → Агенты.',
    findingRegion: 'Проверяю ключ чтением квоты тарифа (без запроса к модели)…',
    found: (region: string, host: string) => `Добавлено. Найден регион: ${region} — ключ ответил на ${host}.`,
    signInAdd: 'Добавить и войти', moveRegion: (label: string) => `Перенести на ${label}`,
    moveRegionNote: (host: string) => `аккаунт и сохранённый ключ перейдут на ${host}`,
    moved: (host: string) => `Перенесено; ключ теперь отправляется только на ${host}.`,
    quickFail: {
      'key-refused': (hosts: string[]) => hosts.length > 1 ? `Ключ не подошёл ни к ${hosts.join(', ни к ')}. Ничего не сохранено.` : `Ключ не подошёл к ${hosts[0] ?? ''}. Ничего не сохранено.`,
      unreachable: (host: string) => `${host} не ответил, ключ не проверен. Ничего не сохранено; повторите или выберите регион в «Дополнительно».`,
      error: (host: string, status: number | null) => `${host} ответил ${status === null ? 'непонятно' : `HTTP ${status}`}. Ничего не сохранено; повторите или выберите регион в «Дополнительно».`,
      'pay-as-you-go': 'Это ключ MiniMax с оплатой по факту (sk-api-…), а не ключ Coding Plan: квоты тарифа у него нет. Добавьте его выше как учётную запись модели (пресет MiniMax). Ничего не отправлялось.',
      busy: 'Ключ этого тарифа уже проверяется.', budget: 'Слишком много проверок за час; повторите позже или выберите регион в «Дополнительно».'
    }
  }
};
const KEY_PROBLEM: Record<'en' | 'ru', Record<string, string>> = {
  en: { whitespace: 'The key contains a space or line break; copy it again.', control: 'The key contains a control character; copy it again.', quote: 'The key contains a double quote; copy it again.', backslash: 'The key contains a backslash; copy it again.' },
  ru: { whitespace: 'В ключе пробел или перевод строки; скопируйте его заново.', control: 'В ключе управляющий символ; скопируйте его заново.', quote: 'В ключе двойная кавычка; скопируйте его заново.', backslash: 'В ключе обратная косая черта; скопируйте его заново.' }
};

let locale: 'en' | 'ru' = 'en';
let t = STRINGS.en;
let state: State | null = null;
const root = document.querySelector('#app')!;
const status = document.querySelector('#status')!;
const say = (message: string): void => { status.textContent = message; };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}
const button = (label: string, name: string, onClick: () => void): HTMLButtonElement => {
  const node = el('button', { type: 'button', textContent: label, name });
  node.addEventListener('click', onClick);
  return node;
};
const field = (label: string, control: HTMLElement): HTMLLabelElement => el('label', { className: 'field' }, el('span', { textContent: label }), control);

async function load(): Promise<void> {
  state = await host.service.request(SERVICE, 'state') as State;
  render();
}

/** Saves run one at a time, each on the accounts the previous one left, so a quick second change keeps the first. */
let saving: Promise<unknown> = Promise.resolve();
function saveAccounts(change: (accounts: Account[]) => Account[]): Promise<boolean> {
  const run = saving.then(async () => {
    if (!state) return false;
    const accounts = change(structuredClone(state.settings.accounts));
    try {
      await host.service.request(SERVICE, 'save', { settings: { version: 1, accounts } });
      say(t.saved);
      await load().catch(error => say(errorText(error)));
      return true;
    } catch (error) {
      say(`${t.notSaved}${errorText(error)}`);
      return false;
    }
  });
  saving = run;
  return run;
}

function agentBoxes(prefix: string, account: Pick<Account, 'preset' | 'responsesApi'>, chosen: readonly Harness[]): { node: HTMLElement; value(): Harness[] } {
  const inputs = new Map<Harness, HTMLInputElement>();
  const node = el('span', { className: 'agents' });
  for (const harness of HARNESSES) {
    if (!harnessSupport(harness, account).ok) continue;
    const input = el('input', { type: 'checkbox', checked: chosen.includes(harness), name: `${prefix}-agent-${harness}` });
    inputs.set(harness, input);
    node.append(el('label', { className: 'check' }, input, ` ${HARNESS_LABELS[harness]}`));
  }
  return { node, value: () => [...inputs].filter(([, input]) => input.checked).map(([harness]) => harness) };
}

function checkLine(result: CheckResult | { error: string }, account: Account): HTMLElement {
  const box = el('div', { className: 'check-result', dataset: { result: account.id } });
  if ('error' in result) { box.textContent = result.error; return box; }
  if (result.kind === 'key') { box.textContent = result.ok ? t.keyCheckOk : t.keyCheckFail(result.problem ?? ''); return box; }
  if (!result.running) { box.textContent = result.problem === 'not-ollama' ? t.notOllama : t.ollamaDown; return box; }
  const lines = [t.ollamaOk(result.version, result.models.length)];
  if (result.model) lines.push(result.model.installed ? (result.model.tools ? t.modelOk : t.modelNoTools) : t.modelMissing);
  box.append(el('div', { textContent: lines.join(' ') }));
  const list = el('ul', { className: 'models' });
  for (const model of result.models.slice(0, 40)) {
    const badges = [model.size, model.tools ? t.tools : null, model.local ? null : t.cloud].filter(Boolean).join(' · ');
    const item = el('li', {}, el('code', { textContent: model.name }), badges ? ` ${badges} ` : ' ');
    if (model.tools && model.name !== account.model) {
      item.append(button(t.use, `use-${account.id}-${model.name}`, () => void saveAccounts(accounts => accounts.map(entry => entry.id === account.id ? { ...entry, model: model.name } : entry))));
    }
    list.append(item);
  }
  box.append(list);
  return box;
}

/** The account's quota as the service last read it, with its age (an old read is shown as old, never hidden). */
function quotaRow(account: Account, quota: QuotaLine): HTMLElement {
  const local = (iso: string): string => new Date(iso).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const parts = [t.quotaState[quota.state] ?? quota.state];
  if (quota.remainingPercent !== null && quota.state !== 'exhausted') parts.push(t.left(quota.remainingPercent, quota.window));
  if (quota.resetsAt) parts.push(t.resets(local(quota.resetsAt)));
  if (quota.readable) parts.push(t.age(quota.ageMinutes));
  const early = quota.events.filter(event => event.kind === 'early-reset').at(-1);
  if (early) parts.push(`${t.earlyReset} ${new Date(early.at).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' })}`);
  const row = el('div', { className: 'row', dataset: { quota: account.id } }, el('span', { className: 'label', textContent: t.quota }),
    el('span', { className: quota.state === 'exhausted' ? 'warn' : 'muted', textContent: quota.readable ? parts.join(' · ') : `${parts.join(' · ')} — ${t.passive}` }));
  if (quota.readable) {
    row.append(button(t.readNow, `quota-read-${account.id}`, () => {
      host.service.request(SERVICE, 'quotaRead', { accountId: account.id }).then(() => load(), error => say(errorText(error)));
    }));
  }
  return row;
}

function accountItem(account: Account): HTMLLIElement {
  const preset = PRESETS.find(entry => entry.id === account.preset)!;
  const item = el('li', { className: 'account', dataset: { account: account.id } });
  item.append(el('div', { className: 'row' }, el('strong', { textContent: account.label }), el('span', { className: 'muted', textContent: `${preset.label} — ${account.baseUrl}` })));
  const label = el('input', { value: account.label, name: `label-${account.id}` });
  const model = el('input', { value: account.model, name: `model-${account.id}` });
  const url = el('input', { value: account.baseUrl, name: `url-${account.id}`, disabled: preset.id === 'ollama-cloud' });
  const responses = el('input', { type: 'checkbox', checked: account.responsesApi === true, name: `responses-${account.id}` });
  // Off unless the person ticks it, account by account (CanvasTTY's brokered requests).
  const brokerable = el('input', { type: 'checkbox', checked: account.brokerable === true, name: `brokerable-${account.id}` });
  const canBroker = brokerableShape(account);
  const agents = agentBoxes(account.id, account, account.agents);
  const edits = el('div', { className: 'row' }, field(t.name, label), field(t.model, model), field(t.address, url));
  if (preset.protocol === 'openai') edits.append(el('label', { className: 'check' }, responses, ` ${t.responses}`));
  item.append(edits, el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.agents }), agents.node));
  if (canBroker) item.append(el('div', { className: 'row' }, el('label', { className: 'check' }, brokerable, ` ${t.brokerable}`)));
  item.append(el('div', { className: 'row' },
    button(t.saveChanges, `save-${account.id}`, () => void saveAccounts(accounts => accounts.map(entry => entry.id !== account.id ? entry : {
      ...entry, label: label.value.trim(), model: model.value.trim(), baseUrl: url.value.trim(), agents: agents.value(),
      ...(preset.protocol === 'openai' ? { responsesApi: responses.checked } : {}),
      brokerable: canBroker && brokerable.checked
    }))),
    button(t.check, `check-${account.id}`, () => {
      say(t.checking);
      host.service.request(SERVICE, 'check', { accountId: account.id }).then(() => { say(''); return load(); }, error => say(errorText(error)));
    }),
    button(t.remove, `remove-${account.id}`, async () => {
      // The account goes first: a failed save leaves it whole with its key, never a keyless account.
      if (!await saveAccounts(accounts => accounts.filter(entry => entry.id !== account.id))) return;
      if (accountKeyed(account)) await host.secrets.delete(secretKeyOf(account.id)).catch(error => say(errorText(error)));
    })));
  if (accountKeyed(account)) item.append(keyRow(account));
  const quota = state!.quota?.[account.id];
  if (quota) item.append(quotaRow(account, quota));
  const check = state!.checks[account.id];
  if (check) item.append(checkLine(check, account));
  return item;
}

function addForm(): HTMLElement {
  const box = el('div', { className: 'add' });
  const preset = el('select', { name: 'preset' });
  // GLM and MiniMax are coding plans: they are added under Subscription accounts.
  for (const entry of PRESETS) if (!PLAN_PRESETS.has(entry.id)) preset.append(el('option', { value: entry.id, textContent: entry.label }));
  const label = el('input', { name: 'label', placeholder: t.name });
  const url = el('input', { name: 'url', placeholder: 'https://…' });
  const model = el('input', { name: 'model', placeholder: t.model });
  const responses = el('input', { type: 'checkbox', name: 'responses' });
  const responsesLabel = el('label', { className: 'check' }, responses, ` ${t.responses}`);
  const agentsSlot = el('span');
  let agents = agentBoxes('new', { preset: 'ollama-local' }, []);
  const sync = (): void => {
    const chosen = PRESETS.find(entry => entry.id === preset.value)!;
    url.value = chosen.baseUrl ?? '';
    url.disabled = chosen.id === 'ollama-cloud';
    model.value = chosen.model;
    label.value = chosen.id.startsWith('custom') ? '' : chosen.label.split(' · ')[0]!;
    responsesLabel.hidden = chosen.protocol !== 'openai';
    const shape = { preset: chosen.id, responsesApi: responses.checked };
    agents = agentBoxes('new', shape, HARNESSES.filter(harness => harnessSupport(harness, shape).ok));
    agentsSlot.replaceChildren(agents.node);
  };
  preset.addEventListener('change', sync);
  responses.addEventListener('change', () => {
    const shape = { preset: preset.value as PresetId, responsesApi: responses.checked };
    agents = agentBoxes('new', shape, HARNESSES.filter(harness => harnessSupport(harness, shape).ok));
    agentsSlot.replaceChildren(agents.node);
  });
  sync();
  box.append(
    el('div', { className: 'row' }, field(t.provider, preset), field(t.name, label)),
    el('div', { className: 'row' }, field(t.address, url), field(t.model, model), responsesLabel),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.agents }), agentsSlot),
    el('div', { className: 'row' }, button(t.add, 'add', () => {
      const chosen = PRESETS.find(entry => entry.id === preset.value)!;
      const name = label.value.trim() || `${chosen.label} · ${model.value.trim()}`;
      const id = newAccountId(`${name}-${model.value}`, new Set(state!.settings.accounts.map(account => account.id)));
      const account: Account = { id, label: name, preset: chosen.id, baseUrl: url.value.trim(), model: model.value.trim(), agents: agents.value(),
        ...(chosen.protocol === 'openai' && responses.checked ? { responsesApi: true } : {}) };
      void saveAccounts(accounts => [...accounts, account]);
    })));
  return box;
}

// ---- subscription pools ----

const TRUSTS = ['unset', 'D0', 'D1', 'D2', 'D3'] as const;
const poolRequest = (method: string, params: unknown): Promise<unknown> => host.service.request(SERVICE, method, params);
const when = (at: number): string => new Date(at).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One line per choice, nothing chosen in advance: the person's own answer (the owner's rule). */
function trustChoice(name: string, current: string | null, onChange: (value: string) => void): HTMLElement {
  const box = el('span', { className: 'agents', dataset: { trust: name } });
  for (const value of TRUSTS) {
    const input = el('input', { type: 'radio', name, value, checked: current === value });
    input.addEventListener('change', () => { if (input.checked) onChange(value); });
    box.append(el('label', { className: 'check' }, input, ` ${value === 'unset' ? t.trustUnset : value}`));
  }
  return box;
}

function poolMember(member: PoolMemberView): HTMLLIElement {
  const item = el('li', { className: 'account', dataset: { pool: member.id } });
  const parts = [member.signingIn ? t.signingIn : t.signState[member.signIn] ?? member.signIn];
  if (member.running) parts.push(t.running(member.running));
  parts.push(member.lastUsedAt ? t.lastUsed(when(member.lastUsedAt)) : t.neverUsed);
  item.append(el('div', { className: 'row' }, el('strong', { textContent: member.label }), el('span', { className: member.signIn === 'signed-in' ? 'muted' : 'warn', textContent: parts.join(' · ') })));
  const quota = member.quota;
  const line = [t.quotaState[quota.state] ?? quota.state];
  if (quota.remainingPercent !== null && quota.state !== 'exhausted') line.push(t.left(quota.remainingPercent, quota.window));
  if (quota.resetsAt) line.push(t.resets(when(Date.parse(quota.resetsAt))));
  line.push(t.age(quota.ageMinutes));
  const early = member.events.filter(event => event.kind === 'early-reset').at(-1);
  if (early) line.push(`${t.earlyReset} ${when(early.at)}`);
  item.append(el('div', { className: 'row', dataset: { quota: member.id } }, el('span', { className: 'label', textContent: t.quota }),
    el('span', { className: quota.state === 'exhausted' ? 'warn' : 'muted', textContent: line.join(' · ') + (member.limitsNote ? ` — ${member.limitsNote}` : '') })));
  item.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.poolTrust }),
    trustChoice(`trust-${member.id}`, member.trust, value => { poolRequest('poolUpdate', { id: member.id, trust: value }).then(() => { say(t.saved); return load(); }, error => say(`${t.notSaved}${errorText(error)}`)); })));
  item.append(el('div', { className: 'row' },
    button(member.signIn === 'signed-in' ? t.signInAgain : t.signIn, `pool-signin-${member.id}`, () => {
      poolRequest('poolSignIn', { accountId: member.id }).then(() => { say(t.poolSignInOpened); return load(); }, error => say(errorText(error)));
    }),
    button(t.poolCheck, `pool-check-${member.id}`, () => { poolRequest('poolCheck', { accountId: member.id }).then(() => load(), error => say(errorText(error))); }),
    button(t.remove, `pool-remove-${member.id}`, () => { poolRequest('poolRemove', { accountId: member.id }).then(() => load(), error => say(errorText(error))); })));
  return item;
}

function poolsSection(pools: PoolsView, plans?: PlansView): HTMLElement {
  const section = el('section', { className: 'pools' }, el('h2', { textContent: t.pools }), el('p', { className: 'muted', textContent: t.poolsLead }));
  if (pools.limits === 'no') section.append(el('p', { className: 'warn', textContent: t.poolLimitsNo }));
  if (pools.homeLimit.over) section.append(el('p', { className: 'warn', textContent: t.poolHomeLimit(pools.homeLimit.limit) }));
  if (!pools.cardEvents) section.append(el('p', { className: 'warn', textContent: t.poolNoEvents }));
  for (const entry of pools.providers) {
    const block = el('div', { className: 'add', dataset: { poolProvider: entry.provider } });
    block.append(el('div', { className: 'row' }, el('strong', { textContent: entry.label }), el('span', { className: 'muted', textContent: t.poolAccounts(entry.accounts.length) })));
    const list = el('ul', { className: 'accounts' });
    if (!entry.accounts.length) list.append(el('li', { className: 'muted', textContent: t.poolNone }));
    for (const member of entry.accounts) list.append(poolMember(member));
    block.append(list);
    section.append(block);
  }
  if (plans) {
    section.append(el('p', { className: 'muted', textContent: t.plansLead }));
    const notices = modelNotices(state!.modelNotices ?? []);
    if (notices) section.append(notices);
    for (const entry of plans.providers) section.append(planBlock(entry));
  }
  section.append(el('p', { className: 'muted', textContent: t.poolRemoveNote }),
    el('p', { className: 'muted', textContent: `${t.notPooled} ${Object.values(pools.notPooled).join(' ')}` }));
  return section;
}

// ---- coding plans (GLM, MiniMax): API-key subscriptions ----

const PLAN_PRESETS = new Set<string>(Object.values(PLAN_INFO).flatMap(info => info.presets));

/** The key row of a keyed account: write-only, checked locally, bound to the account's host by the service. */
function keyRow(account: Account): HTMLElement {
  const keyState = state!.keys[account.id] ?? 'missing';
  const input = el('input', { type: 'password', placeholder: t.key, autocomplete: 'off', name: `key-${account.id}` });
  return el('div', { className: 'row' },
    el('span', { className: 'muted', textContent: keyState === 'ok' ? t.keyOk : keyState === 'other-address' ? t.keyOther : t.keyMissing }),
    input,
    button(t.saveKey, `save-key-${account.id}`, async () => {
      const value = input.value.trim();
      if (!value) return;
      const problem = apiKeyProblem(value);
      if (problem) { input.value = ''; say(KEY_PROBLEM[locale][problem] ?? problem); return; }
      let stored = false;
      try {
        await host.secrets.set(secretKeyOf(account.id), value);
        stored = true; input.value = '';
        await host.service.request(SERVICE, 'keyChanged', { accountId: account.id });
        say(t.keySaved);
      } catch (error) { say(`${t.notSaved}${errorText(error)}`); }
      if (stored) await load();
    }),
    button(t.removeKey, `remove-key-${account.id}`, async () => {
      try {
        await host.secrets.delete(secretKeyOf(account.id));
        await host.service.request(SERVICE, 'keyChanged', { accountId: account.id });
        say(t.keyRemoved);
      } catch (error) { say(errorText(error)); }
      await load();
    }));
}

function planMember(account: Account): HTMLLIElement {
  const info = state!.plans?.accounts[account.id];
  const item = el('li', { className: 'account', dataset: { plan: account.id } });
  const regionLabel = info ? PLAN_INFO[info.provider].regions[info.region].label[locale] : '';
  item.append(el('div', { className: 'row' }, el('strong', { textContent: account.label }),
    el('span', { className: 'muted', textContent: [regionLabel, account.smallModel ? `${account.model} / ${account.smallModel}` : account.model, info ? t.planHost(info.host) : null, info ? t.planRunning(info.running, info.concurrency) : null].filter(Boolean).join(' · ') })));
  item.append(keyRow(account));
  const quota = state!.quota?.[account.id];
  if (quota) item.append(quotaRow(account, quota));
  item.append(el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.poolTrust }),
    trustChoice(`plan-trust-${account.id}`, account.trust ?? 'unset', value => {
      void saveAccounts(accounts => accounts.map(entry => entry.id === account.id ? { ...entry, trust: value as Account['trust'] } : entry));
    })));
  const label = el('input', { value: account.label, name: `plan-label-${account.id}` });
  const cap = el('input', { type: 'number', min: '1', max: String(MAX_CONCURRENCY), value: String(account.concurrency ?? DEFAULT_CONCURRENCY), name: `plan-concurrency-${account.id}` });
  const auto = el('input', { type: 'checkbox', checked: account.brokerable === true, name: `plan-auto-${account.id}` });
  const list = state!.models?.[account.id];
  const main = modelSelect(`plan-model-${account.id}`, info?.provider, list, list?.defaults.model ?? account.model, account.modelPinned === true ? account.model : null);
  const small = modelSelect(`plan-small-model-${account.id}`, info?.provider, list, list?.defaults.smallModel ?? account.smallModel ?? account.model,
    account.smallModelPinned === true ? account.smallModel ?? account.model : null);
  item.append(el('div', { className: 'row' }, field(t.mainModel, main), field(t.smallModel, small)));
  if (list) {
    const age = list.readAt === null ? null : Math.max(0, Math.round((Date.now() - list.readAt) / 60_000));
    item.append(el('div', { className: 'row', dataset: { models: account.id } }, el('span', { className: 'muted', textContent:
      (list.source === 'live' && age !== null ? t.listLive(info?.host ?? '', t.listAge(age)) : t.listBundled(BUNDLED_CHECKED)) + (list.note ? ` (${list.note})` : '') })));
  }
  item.append(el('div', { className: 'row' }, field(t.name, label), field(t.concurrency, cap)),
    el('div', { className: 'row' }, el('label', { className: 'check' }, auto, ` ${t.forAuto}`)),
    el('div', { className: 'row' },
      button(t.saveChanges, `plan-save-${account.id}`, () => void saveAccounts(accounts => accounts.map(entry => {
        if (entry.id !== account.id) return entry;
        // An empty choice follows the plan's list (the service fills in its newest model); a model is the person's pick.
        const { modelPinned: _m, smallModelPinned: _s, ...rest } = entry;
        const model = main.value || entry.model;
        const smallModel = small.value || entry.smallModel;
        return { ...rest, label: label.value.trim(), concurrency: Number(cap.value), brokerable: auto.checked, model,
          ...(smallModel && smallModel !== model ? { smallModel } : { smallModel: undefined }),
          ...(main.value ? { modelPinned: true } : {}), ...(small.value ? { smallModelPinned: true } : {}) } as Account;
      }))),
      button(t.remove, `plan-remove-${account.id}`, async () => {
        if (!await saveAccounts(accounts => accounts.filter(entry => entry.id !== account.id))) return;
        await host.secrets.delete(secretKeyOf(account.id)).catch(error => say(errorText(error)));
      })));
  if (info) {
    // The key stays on the host it was found on; only the person moves it to the plan's other host.
    const other: PlanRegion = info.region === 'intl' ? 'cn' : 'intl';
    const target = PLAN_INFO[info.provider].regions[other];
    item.append(el('div', { className: 'row' },
      button(t.moveRegion(target.label[locale]), `plan-region-${account.id}`, () => {
        host.service.request(SERVICE, 'planRegion', { accountId: account.id, region: other })
          .then(answer => { say(t.moved((answer as { host: string }).host)); return load(); }, error => say(`${t.notSaved}${errorText(error)}`));
      }), el('span', { className: 'muted', textContent: t.moveRegionNote(target.host) })));
  }
  return item;
}

/** A plan account's model choice: "newest on the list" (follows it) or one model of the list (the person's pick). */
function modelSelect(name: string, provider: PlanProvider | undefined, list: PlanModelList | undefined, newest: string, pinned: string | null): HTMLSelectElement {
  const select = el('select', { name });
  select.append(el('option', { value: '', textContent: t.newest(newest), selected: pinned === null }));
  const models = list ? [...list.models] : [];
  if (pinned && !models.some(id => id.toLowerCase() === pinned.toLowerCase())) models.push(pinned);
  for (const id of provider ? sortModels(provider, models) : models) {
    const off = !list?.models.some(entry => entry.toLowerCase() === id.toLowerCase());
    select.append(el('option', { value: id, textContent: off ? `${id} — ${t.notListed}` : id, selected: pinned !== null && pinned.toLowerCase() === id.toLowerCase() }));
  }
  return select;
}

/** Accounts whose model followed the plan's list without the person choosing: said once, until «OK». */
function modelNotices(notices: readonly ModelNotice[]): HTMLElement | null {
  if (!notices.length) return null;
  const box = el('div', { className: 'add', dataset: { modelNotices: String(notices.length) } }, el('strong', { textContent: t.modelsMoved }));
  const list = el('ul', { className: 'accounts' });
  for (const notice of notices) list.append(el('li', { textContent: t.modelMoved(notice) }));
  box.append(list, el('p', { className: 'muted', textContent: t.modelsMovedWhy }),
    el('div', { className: 'row' }, button(t.ok, 'model-notices-seen', () => {
      host.service.request(SERVICE, 'modelNoticesSeen').then(() => load(), error => say(errorText(error)));
    })));
  return box;
}

function planBlock(entry: PlansView['providers'][number]): HTMLElement {
  const members = state!.settings.accounts.filter(account => state!.plans?.accounts[account.id]?.provider === entry.provider);
  const block = el('div', { className: 'add', dataset: { planProvider: entry.provider } });
  block.append(el('div', { className: 'row' }, el('strong', { textContent: entry.label }), el('span', { className: 'muted', textContent: t.poolAccounts(members.length) })));
  const list = el('ul', { className: 'accounts' });
  if (!members.length) list.append(el('li', { className: 'muted', textContent: t.poolNone }));
  for (const account of members) list.append(planMember(account));
  block.append(list);
  return block;
}

// ---- quick add: a provider tile and the key; everything else under «Дополнительно» ----

type Tile = { kind: 'plan'; provider: PlanProvider } | { kind: 'pool'; provider: string; label: string };
/** The open tile and the data class chosen inline, kept across re-renders (the service's events re-render the page). */
let openTile: string | null = null;
let inlineClass: DataClass | null = null;
const DEFAULT_CLASSES: readonly DataClass[] = ['D0', 'D1', 'D2', 'D3'];
const PROBE_SECRET = (provider: PlanProvider): string => `probe.${provider}`;

/** The data class a new account gets: the person's default, their inline answer (then remembered), or none under Off. */
async function newAccountClass(): Promise<{ ok: true; trust?: string } | { ok: false }> {
  const defaults = state!.defaults;
  if (defaults?.dataClass) return { ok: true, trust: defaults.dataClass };
  if (defaults?.dataClassMode === 'off') return { ok: true };
  if (!inlineClass) { say(t.dataChooseFirst); return { ok: false }; }
  await host.service.request(SERVICE, 'setDefaults', { dataClass: inlineClass });
  return { ok: true, trust: inlineClass };
}

/** «Класс данных для новых аккаунтов»: a compact choice; once set, a change is saved at once. */
function dataDefaultRow(): HTMLElement {
  const defaults = state!.defaults;
  if (defaults?.dataClassMode === 'off' && !defaults.dataClass) return el('p', { className: 'muted', dataset: { dataDefault: 'off' }, textContent: t.dataOff });
  const current = defaults?.dataClass ?? null;
  const box = el('span', { className: 'agents' });
  for (const value of DEFAULT_CLASSES) {
    const input = el('input', { type: 'radio', name: 'data-default', value, checked: (current ?? inlineClass) === value });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      if (!current) { inlineClass = value; return; }
      host.service.request(SERVICE, 'setDefaults', { dataClass: value }).then(() => { say(t.saved); return load(); }, error => say(`${t.notSaved}${errorText(error)}`));
    });
    box.append(el('label', { className: 'check' }, input, ` ${value}`));
  }
  return el('div', { className: 'row', dataset: { dataDefault: current ?? 'ask' } }, el('span', { className: 'label', textContent: current ? t.dataDefault : t.dataAsk }), box);
}

function quickFailText(result: Extract<QuickAddResult, { added: false }>): string {
  const last = result.tried.at(-1);
  switch (result.reason) {
    case 'key-refused': return t.quickFail['key-refused'](result.tried.map(entry => entry.host));
    case 'unreachable': return t.quickFail.unreachable(last?.host ?? '');
    case 'error': return t.quickFail.error(last?.host ?? '', last?.status ?? null);
    case 'pay-as-you-go': return t.quickFail['pay-as-you-go'];
    case 'busy': return t.quickFail.busy;
    case 'budget': return t.quickFail.budget;
    case 'trust-needed': return t.dataChooseFirst;
    case 'no-key': return t.planKeyFirst;
    default: return `${t.notSaved}${result.message}`;
  }
}

function planQuickForm(provider: PlanProvider): HTMLElement {
  const info = state!.plans!.providers.find(entry => entry.provider === provider)!;
  const key = el('input', { type: 'password', placeholder: t.key, autocomplete: 'off', name: `quick-key-${provider}` });
  const label = el('input', { name: `quick-label-${provider}`, placeholder: t.name });
  const region = el('select', { name: `quick-region-${provider}` });
  region.append(el('option', { value: '', textContent: t.regionAuto }));
  for (const option of info.regions) region.append(el('option', { value: option.region, textContent: option.label[locale] }));
  const cap = el('input', { type: 'number', min: '1', max: String(MAX_CONCURRENCY), value: String(DEFAULT_CONCURRENCY), name: `quick-concurrency-${provider}` });
  const auto = el('input', { type: 'checkbox', checked: true, name: `quick-auto-${provider}` });
  let trust: string | null = null;
  const advanced = el('details', { className: 'advanced', dataset: { advanced: provider } }, el('summary', { textContent: t.advanced }),
    el('div', { className: 'row' }, field(t.name, label), field(t.region, region), field(t.concurrency, cap)),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.poolTrust }), trustChoice(`quick-trust-${provider}`, null, value => { trust = value; })),
    el('div', { className: 'row' }, el('label', { className: 'check' }, auto, ` ${t.forAuto}`)));
  const add = button(t.add, `quick-add-${provider}`, async () => {
    const value = key.value.trim();
    if (!value) { say(t.planKeyFirst); return; }
    const problem = apiKeyProblem(value);
    if (problem) { key.value = ''; say(KEY_PROBLEM[locale][problem] ?? problem); return; }
    add.disabled = true;
    try {
      const chosen = trust ? { ok: true as const, trust } : await newAccountClass();
      if (!chosen.ok) return;
      say(t.findingRegion);
      await host.secrets.set(PROBE_SECRET(provider), value);
      let result: QuickAddResult;
      try {
        result = await host.service.request(SERVICE, 'planQuickAdd', {
          provider, ...(region.value ? { region: region.value as PlanRegion } : {}), ...(label.value.trim() ? { label: label.value.trim() } : {}),
          ...(chosen.trust ? { trust: chosen.trust } : {}), concurrency: Number(cap.value), brokerable: auto.checked
        }) as QuickAddResult;
        if (!result.added) { say(quickFailText(result)); await load().catch(() => undefined); return; }
        await host.secrets.set(secretKeyOf(result.id), value);
        key.value = '';
        await host.service.request(SERVICE, 'keyChanged', { accountId: result.id });
      } finally {
        await host.secrets.delete(PROBE_SECRET(provider)).catch(() => undefined);
      }
      const regionLabel = PLAN_INFO[provider].regions[result.region].label[locale];
      const quota = result.quota && result.quota.remainingPercent !== null ? ` ${t.quota}: ${t.left(result.quota.remainingPercent, result.quota.window)}.` : '';
      const autoLine = result.forAuto ? ` ${result.autoSeen ? '' : `${t.autoNote} `}${t.grantNote}` : '';
      openTile = null;
      inlineClass = null;
      await load().catch(error => say(errorText(error)));
      say(`${t.found(regionLabel, result.host)}${quota}${autoLine}`);
    } catch (error) {
      say(`${t.notSaved}${errorText(error)}`);
    } finally {
      add.disabled = false;
    }
  });
  return el('div', { className: 'add', dataset: { quick: provider } }, el('div', { className: 'row' }, field(t.key, key), add), advanced);
}

function poolQuickForm(provider: string, hint: string): HTMLElement {
  const label = el('input', { name: `quick-label-${provider}`, placeholder: t.name });
  let trust: string | null = null;
  const advanced = el('details', { className: 'advanced', dataset: { advanced: provider } }, el('summary', { textContent: t.advanced }),
    el('div', { className: 'row' }, field(t.name, label)),
    el('div', { className: 'row' }, el('span', { className: 'label', textContent: t.poolTrust }), trustChoice(`quick-trust-${provider}`, null, value => { trust = value; })));
  const add = button(t.signInAdd, `quick-add-${provider}`, async () => {
    add.disabled = true;
    try {
      const chosen = trust ? { ok: true as const, trust } : await newAccountClass();
      if (!chosen.ok) return;
      const answer = await poolRequest('poolAdd', { provider, label: label.value.trim(), trust: chosen.trust ?? 'unset' }) as { signIn?: { error?: string } };
      openTile = null;
      inlineClass = null;
      await load().catch(error => say(errorText(error)));
      say(answer.signIn && 'error' in answer.signIn ? String(answer.signIn.error) : t.poolSignInOpened);
    } catch (error) {
      say(`${t.notSaved}${errorText(error)}`);
    } finally {
      add.disabled = false;
    }
  });
  return el('div', { className: 'add', dataset: { quick: provider } }, el('div', { className: 'row' }, add, el('span', { className: 'muted', textContent: hint })), advanced);
}

/** «Добавить подписку»: provider tiles; the open tile's form is the key (or the sign-in) and a collapsed «Дополнительно». */
function quickAddSection(): HTMLElement {
  const tiles: Tile[] = [
    ...(state!.plans?.providers ?? []).map(entry => ({ kind: 'plan' as const, provider: entry.provider })),
    ...(state!.pools?.providers ?? []).map(entry => ({ kind: 'pool' as const, provider: entry.provider, label: entry.label }))
  ];
  const defaults = state!.defaults;
  const section = el('section', { className: 'quick', dataset: { quickAdd: '' } }, el('h2', { textContent: t.quickAdd }), el('p', { className: 'muted', textContent: t.quickLead }));
  const row = el('div', { className: 'row tiles' });
  for (const tile of tiles) {
    const text = tile.kind === 'plan' ? `+ ${tile.provider === 'glm' ? 'GLM' : 'MiniMax'}` : `+ ${t.tileSignIn(tile.label)}`;
    const node = button(text, `tile-${tile.provider}`, () => { openTile = openTile === tile.provider ? null : tile.provider; render(); });
    node.setAttribute('aria-pressed', String(openTile === tile.provider));
    row.append(node);
  }
  section.append(row);
  const open = tiles.find(tile => tile.provider === openTile);
  const asked = !defaults?.dataClass && defaults?.dataClassMode !== 'off';
  if (open) {
    // Asked once, inline, only while no default is set (and never when data classes are off).
    if (asked) section.append(dataDefaultRow());
    if (open.kind === 'plan') {
      section.append(planQuickForm(open.provider));
      if (!defaults?.autoSeenAt) section.append(el('p', { className: 'muted', dataset: { autoNote: '' }, textContent: t.autoNote }));
    } else {
      section.append(poolQuickForm(open.provider, state!.pools!.providers.find(entry => entry.provider === open.provider)?.signInHint[locale] ?? ''));
    }
  }
  if (!asked) section.append(dataDefaultRow());
  return section;
}


function render(): void {
  if (!state) return;
  const list = el('ul', { className: 'accounts' });
  if (!state.settings.accounts.some(account => !planOf(account))) list.append(el('li', { className: 'muted', textContent: t.none }));
  for (const account of state.settings.accounts) if (!planOf(account)) list.append(accountItem(account));
  root.replaceChildren(
    el('h1', { textContent: t.title }),
    ...(state.plans && state.pools ? [quickAddSection()] : []),
    el('p', { className: 'muted', textContent: t.lead }),
    list,
    el('h2', { textContent: t.add }),
    addForm(),
    el('p', { className: 'muted', textContent: t.keyWriteOnly }),
    ...(state.pools ? [poolsSection(state.pools, state.plans)] : [])
  );
}

// The service tells the page when a sign-in card ends or a quota changes: one listener for the page's lifetime.
host.service.onEvent?.(event => { if (event?.event === 'pools' || event?.event === 'quota') void load().catch(() => undefined); });

host.onContext(({ appearance }) => {
  locale = appearance.locale === 'ru' ? 'ru' : 'en';
  t = STRINGS[locale];
  document.documentElement.lang = locale;
  render();
});
load().catch(error => say(errorText(error)));

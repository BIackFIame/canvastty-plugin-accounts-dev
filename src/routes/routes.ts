/**
 * L24 for orchestrators: which of the person's model accounts a subagent can run on, and the one to pick. An
 * orchestrator lists them with `canvastty-accounts__list_routes`, or asks `canvastty-accounts__pick_account`, and passes
 * the answer's `launchOptions` to `spawn_agent`. Accounts known not to work right now are skipped with the reason
 * (L24's "skip dead logins": no key, Ollama not running, the model not installed or without tool calling); nothing here
 * launches, sends a key anywhere or asks a model. The agent's own CLI sign-in is CanvasTTY's, not this plugin's: a
 * spawn without launchOptions uses it.
 */
import { DECISIONS_ONLY_REASON, HARNESS_LABELS, HARNESSES, accountKeyed, decisionsOnlyAccount, harnessSupport, ollamaShapeOf, presetOf, type Account, type Harness } from '../shared/accounts.ts';
import { parseOllamaModelRef } from '../shared/ollamaModelRef.ts';
import { ollamaVersionRefusal, type OllamaDetection } from '../launch/ollama.ts';
import { PROVIDER_EFFORTS, isEffort } from '../launch/effort.ts';

export const PLUGIN_ID = 'canvastty-accounts';

export type RouteState = 'ready' | 'no-key' | 'key-for-other-address' | 'ollama-down' | 'ollama-old' | 'model-missing' | 'no-tools' | 'cloud-off' | 'no-effort'
  /** An OpenRouter account: OpenRouter is for the Assistant's Jev decisions only, never a subagent's model traffic. */
  | 'decisions-only';

/** Accounts probed at once (keys through the host, Ollama servers over loopback). */
const PROBE_CONCURRENCY = 4;

export interface RouteRow {
  provider: Harness;
  agent: string;
  accountId: string;
  account: string;
  kind: 'ollama' | 'ollama-cloud' | 'api-key';
  model: string;
  /** Where requests go: a host name, never a key or a path with secrets. */
  endpoint: string;
  state: RouteState;
  reason?: string;
  /** Pass as `spawn_agent` `launchOptions` (only when ready). */
  launchOptions?: Record<string, Record<string, string | boolean>>;
}

export interface RouteFacts {
  /** The key's state per keyed account. */
  key(account: Account): Promise<'ok' | 'missing' | 'other-address'>;
  /** One detection per Ollama server address (cached for one call). */
  ollama(baseUrl: string): Promise<OllamaDetection>;
}

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url.slice(0, 60); } };

export const launchOptionsFor = (accountId: string, effort = 'default'): Record<string, Record<string, string | boolean>> =>
  ({ [PLUGIN_ID]: { account: accountId, effort, trustFolder: false } });

interface Evaluated { state: RouteState; reason?: string; ollamaVersion?: string | null }

async function stateOf(account: Account, facts: RouteFacts): Promise<Evaluated> {
  // Before anything is probed: its key is not even read.
  if (decisionsOnlyAccount(account)) return { state: 'decisions-only', reason: DECISIONS_ONLY_REASON };
  if (accountKeyed(account)) {
    const key = await facts.key(account);
    if (key === 'missing') return { state: 'no-key', reason: 'no key is saved for it (Accounts settings)' };
    if (key === 'other-address') return { state: 'key-for-other-address', reason: 'its key was saved for another address; the person must save it again' };
  }
  const shape = ollamaShapeOf(account);
  if (shape === 'local' || shape === 'cloud-local') {
    const detection = await facts.ollama(account.baseUrl);
    if (!detection.running) return { state: 'ollama-down', reason: detection.problem === 'not-ollama' ? 'the address does not answer like Ollama' : 'Ollama is not running on this computer' };
    if (shape === 'cloud-local') return detection.cloudDisabled === true ? { state: 'cloud-off', reason: 'Ollama Cloud is turned off on this server' } : { state: 'ready', ollamaVersion: detection.version };
    const base = parseOllamaModelRef(account.model).base;
    const listed = detection.models.find(model => model.name === base || model.name === `${base}:latest`);
    if (!listed || listed.source !== 'local') return { state: 'model-missing', reason: `${account.model} is not installed on this computer (the person runs ollama pull)` };
    if (!listed.agentReady) return { state: 'no-tools', reason: `${account.model} has no tool calling, so it cannot drive an agent` };
    return { state: 'ready', ollamaVersion: detection.version };
  }
  return { state: 'ready' };
}

/** `run` over `items` with at most `limit` at once; results in the items' order. */
async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const index = next++; results[index] = await run(items[index]!, index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A requested effort the orchestrator can pass: "default", or a level some agent takes. Anything else is an error. */
export function checkEffort(effort: string | undefined): string {
  if (effort === undefined || effort === '' || effort === 'default') return 'default';
  if (!isEffort(effort)) throw new Error(`There is no reasoning effort "${effort.slice(0, 20)}"; use default, minimal, low, medium, high, xhigh or max.`);
  return effort;
}

/** Every account × agent the orchestrator could spawn, optionally for one agent; in the person's settings order. */
export async function listRoutes(accounts: readonly Account[], facts: RouteFacts, filter: { provider?: string; model?: string; effort?: string } = {}): Promise<RouteRow[]> {
  const effort = checkEffort(filter.effort);
  // The rows asked for, before anything is probed: an account with none is not checked at all.
  const wanted = accounts.map(account => HARNESSES.filter(harness =>
    (filter.provider === undefined || filter.provider === harness) && account.agents.includes(harness) && harnessSupport(harness, account).ok
    && (!filter.model || account.model.toLowerCase().includes(filter.model.toLowerCase()))));
  const evaluated = await mapBounded(accounts, PROBE_CONCURRENCY, (account, index) => wanted[index]!.length ? stateOf(account, facts) : Promise.resolve(null));
  const rows: RouteRow[] = [];
  accounts.forEach((account, index) => {
    const shape = ollamaShapeOf(account);
    for (const harness of wanted[index]!) {
      // The same rules the launch applies: a route is ready only if its launch would be.
      let { state, reason } = evaluated[index]!;
      const old = state === 'ready' && shape ? ollamaVersionRefusal(shape, harness, evaluated[index]!.ollamaVersion ?? null) : null;
      if (old) { state = 'ollama-old'; reason = old; }
      if (state === 'ready' && effort !== 'default' && !PROVIDER_EFFORTS[harness]?.includes(effort as never)) {
        state = 'no-effort'; reason = `${HARNESS_LABELS[harness]} has no reasoning effort "${effort}"`;
      }
      rows.push({
        provider: harness, agent: HARNESS_LABELS[harness], accountId: account.id, account: account.label,
        kind: shape === 'local' ? 'ollama' : shape ? 'ollama-cloud' : 'api-key', model: account.model, endpoint: hostOf(account.baseUrl),
        state, ...(reason !== undefined ? { reason } : {}), ...(state === 'ready' ? { launchOptions: launchOptionsFor(account.id, effort) } : {})
      });
    }
  });
  return rows;
}

export interface Pick {
  accountId: string;
  account: string;
  model: string;
  launchOptions: Record<string, Record<string, string | boolean>>;
  why: string;
}

/** The first ready account for `provider` in the person's order; throws a sentence with what was skipped and why. */
export async function pickAccount(accounts: readonly Account[], facts: RouteFacts, request: { provider: string; model?: string; effort?: string }): Promise<Pick> {
  const agent = (HARNESS_LABELS as Record<string, string>)[request.provider] ?? request.provider;
  if (!(HARNESSES as readonly string[]).includes(request.provider)) throw new Error(`No model account can run ${agent}; spawn it without launchOptions to use its own sign-in.`);
  const effort = checkEffort(request.effort);
  if (effort !== 'default' && !PROVIDER_EFFORTS[request.provider]?.includes(effort as never)) throw new Error(`${agent} has no reasoning effort "${effort}".`);
  const rows = await listRoutes(accounts, facts, request);
  const chosen = rows.find(row => row.state === 'ready');
  const skipped = rows.filter(row => row.state !== 'ready').map(row => `${row.account} (${row.model}): ${row.reason}`);
  if (!chosen) {
    const none = rows.length ? `none is ready: ${skipped.join('; ')}` : `the person set up none${request.model ? ` with a model like "${request.model}"` : ''}`;
    throw new Error(`No model account for ${agent}: ${none}. Spawn it without launchOptions to use ${agent}'s own sign-in, or ask the person.`);
  }
  const why = `${agent} on ${chosen.account} (${chosen.model}, ${chosen.kind === 'ollama' ? 'Ollama on this computer' : chosen.endpoint}): the first ready account in the person's order`
    + (skipped.length ? `; skipped ${skipped.join('; ')}` : '') + '.';
  return { accountId: chosen.accountId, account: chosen.account, model: chosen.model, launchOptions: chosen.launchOptions!, why };
}

export const presetLabel = (account: Account): string => presetOf(account).label;

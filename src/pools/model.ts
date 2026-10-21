/**
 * Pool accounts as saved, and which one a launch gets. Pure: the service, the settings page and the tests decide from
 * the same functions.
 *
 * The owner's rules: no cap on how many accounts a person adds (only a storage bound); the data-class level of each
 * account is the person's choice and is never filled in for them ("unset" until they choose); unknown quota is never
 * "used up".
 */
import { isPoolProvider, type PoolProvider } from './providers.ts';
import type { QuotaView } from '../quota/model.ts';

export const DATA_CLASSES = ['D0', 'D1', 'D2', 'D3'] as const;
export type DataClass = typeof DATA_CLASSES[number];
/** The level the person trusts the account with; `unset` until they choose. */
export type PoolTrust = DataClass | 'unset';
const RANK: Readonly<Record<DataClass, number>> = Object.freeze({ D0: 0, D1: 1, D2: 2, D3: 3 });

export interface PoolAccount {
  /** `[a-z0-9][a-z0-9-]{0,39}`, unique across pools. */
  id: string;
  provider: PoolProvider;
  label: string;
  trust: PoolTrust;
  addedAt: number;
}

export interface PoolSettings { version: 1; accounts: PoolAccount[] }
/** A storage bound (one saved value stays far below the host's 1 MiB frame), not a limit the person meets in practice. */
export const MAX_POOL_ACCOUNTS = 1_000;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

export function validatePoolAccount(value: unknown): PoolAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A pool account must be an object.');
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find(key => !['id', 'provider', 'label', 'trust', 'addedAt'].includes(key));
  if (unknown) throw new Error(`Unknown pool account field ${unknown.slice(0, 40)}.`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) throw new Error('Pool account id must be 1–40 lowercase letters, digits or dashes.');
  if (!isPoolProvider(raw.provider)) throw new Error('Choose an agent for the pool account.');
  if (!plain(raw.label, 80)) throw new Error('Give the account a name (at most 80 characters).');
  if (raw.trust !== 'unset' && !(DATA_CLASSES as readonly unknown[]).includes(raw.trust)) throw new Error('Choose how far you trust the account: not set, D0, D1, D2 or D3.');
  const addedAt = typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0;
  return { id: raw.id, provider: raw.provider, label: raw.label.trim(), trust: raw.trust as PoolTrust, addedAt };
}

/** Saved pools: invalid or repeated entries are dropped instead of losing every account. */
export function loadPools(value: unknown): PoolSettings {
  const list = value && typeof value === 'object' && Array.isArray((value as { accounts?: unknown }).accounts) ? (value as { accounts: unknown[] }).accounts : [];
  const accounts: PoolAccount[] = [];
  for (const entry of list.slice(0, MAX_POOL_ACCOUNTS)) {
    try {
      const account = validatePoolAccount(entry);
      if (!accounts.some(existing => existing.id === account.id)) accounts.push(account);
    } catch { /* dropped */ }
  }
  return { version: 1, accounts };
}

/** A fresh id: `grok-7`, `claude-work`, … (never one of `taken`, which holds model account ids too). */
export function newPoolId(provider: PoolProvider, label: string, taken: ReadonlySet<string>): string {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 24);
  const base = `${provider}-${slug || 'account'}`.slice(0, 32).replace(/-+$/u, '');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- choosing an account ----

export type SignIn = 'signed-in' | 'signed-out' | 'expired' | 'unknown';

/** What is known about one member right now. */
export interface MemberFacts {
  signIn: SignIn;
  quota: QuotaView;
  /** Cards running in the home now, plus picks handed out and not launched yet. */
  active: number;
  lastUsedAt: number | null;
}

export type DataClassMode = 'strict' | 'warn' | 'off';
export interface PickRequest {
  /** The task's data class, when the caller knows it. */
  dataClass?: DataClass;
  /** How the class is applied (the person's global setting, passed by the caller); `warn` when only a class is given. */
  mode?: DataClassMode;
}

export interface Ranked { account: PoolAccount; facts: MemberFacts; covers: boolean | null; note?: string }
export interface Skipped { account: PoolAccount; reason: string }

export const covers = (trust: PoolTrust, dataClass: DataClass): boolean => trust !== 'unset' && RANK[trust] >= RANK[dataClass];

/** Exact quota first, then estimated, then unknown; an account running low goes after every one with room. */
const tier = (view: QuotaView): number => view.state === 'low' ? 3 : view.confidence === 'exact' ? 0 : view.confidence === 'estimated' ? 1 : 2;
/** Headroom in 10-point steps, so accounts with about the same room take turns (fewest active, then least recently used). */
const headroom = (view: QuotaView): number => view.remainingPercent === null ? -1 : Math.floor(view.remainingPercent / 10);

/**
 * The members a launch may use, best first, and the others with the reason. Skipped: not signed in (or signed out),
 * quota used up (fresh, reset still ahead), a card already running in the home (one writer per sign-in), and in strict
 * mode a level below the task's class. Order: in warn mode the members whose level covers the class first; then
 * exact quota, estimated, unknown (running low last); most headroom; fewest active; the reset that comes sooner (its
 * quota would be lost otherwise); least recently used; the person's order.
 */
export function rankPool(members: readonly PoolAccount[], facts: (account: PoolAccount) => MemberFacts, request: PickRequest = {}): { ranked: Ranked[]; skipped: Skipped[] } {
  const mode: DataClassMode = request.dataClass ? request.mode ?? 'warn' : 'off';
  const ranked: Array<Ranked & { index: number }> = [];
  const skipped: Skipped[] = [];
  members.forEach((account, index) => {
    const known = facts(account);
    if (known.signIn === 'signed-out') { skipped.push({ account, reason: 'not signed in (sign in again in the Accounts settings)' }); return; }
    if (known.signIn === 'expired') { skipped.push({ account, reason: 'its sign-in expired (sign in again in the Accounts settings)' }); return; }
    if (known.quota.state === 'exhausted') { skipped.push({ account, reason: `its quota is used up (${known.quota.note})` }); return; }
    if (known.active > 0) { skipped.push({ account, reason: 'a card already runs on it (one card per sign-in, so its refresh token is not used twice)' }); return; }
    const covered = request.dataClass && mode !== 'off' ? covers(account.trust, request.dataClass) : null;
    if (covered === false && mode === 'strict') {
      skipped.push({ account, reason: account.trust === 'unset' ? `the person has not set its data level; this task is ${request.dataClass}` : `trusted up to ${account.trust}; this task is ${request.dataClass}` });
      return;
    }
    ranked.push({ account, facts: known, covers: covered, index, ...(covered === false ? { note: `below this task's class ${request.dataClass} (${account.trust === 'unset' ? 'level not set' : `up to ${account.trust}`}); the person chose to be warned only` } : {}) });
  });
  ranked.sort((a, b) =>
    (mode === 'warn' ? Number(a.covers === false) - Number(b.covers === false) : 0)
    || tier(a.facts.quota) - tier(b.facts.quota)
    || headroom(b.facts.quota) - headroom(a.facts.quota)
    || a.facts.active - b.facts.active
    || (a.facts.quota.resetsAt ?? Infinity) - (b.facts.quota.resetsAt ?? Infinity)
    || (a.facts.lastUsedAt ?? 0) - (b.facts.lastUsedAt ?? 0)
    || a.index - b.index);
  return { ranked: ranked.map(({ index: _index, ...entry }) => entry), skipped };
}

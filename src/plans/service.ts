/**
 * Coding-plan pools (`pool:glm`, `pool:minimax`) inside the Accounts service: which plan account a launch or a pick
 * gets. The accounts are model accounts on the plan's host (plans/plans.ts), so keys, their host binding, the quota
 * reader and the launch recipes are the model accounts' own; this class only counts the cards running on each account
 * (several at once are fine for a key, up to the person's cap) and ranks the accounts by headroom with the pools' rules.
 */
import type { Account, Harness } from '../shared/accounts.ts';
import { rankPool, type DataClass, type DataClassMode, type MemberFacts, type Ranked, type Skipped } from '../pools/model.ts';
import type { QuotaView } from '../quota/model.ts';
import { PLAN_HARNESSES, PLAN_INFO, PLAN_PROVIDERS, concurrencyOf, planOf, type PlanProvider } from './plans.ts';

const RESERVATION_MS = 60_000;
const MAX_SESSIONS = 4_096;

/** A plan account as ranking sees it. */
export interface PlanMember { id: string; label: string; trust: NonNullable<Account['trust']>; account: Account; provider: PlanProvider }
export type KeyState = 'ok' | 'missing' | 'other-address';

export class PlanPool {
  private readonly now: () => number;
  /** Session id -> plan account the card runs on. */
  private readonly sessions = new Map<string, string>();
  /** Cards running now (released on exit or close; counted only when CanvasTTY sends card events). */
  private readonly running = new Set<string>();
  private readonly reservations = new Map<string, number[]>();
  private readonly lastUsed = new Map<string, number>();

  private readonly cardEvents: () => boolean;

  constructor(options: { now?: () => number; cardEvents: () => boolean }) {
    this.now = options.now ?? Date.now;
    this.cardEvents = options.cardEvents;
  }

  /** The plan accounts of `provider` (or every plan), in the person's order. */
  members(accounts: readonly Account[], provider?: PlanProvider): PlanMember[] {
    return accounts.flatMap(account => {
      const plan = planOf(account);
      return plan && (!provider || plan.provider === provider) ? [{ id: account.id, label: account.label, trust: account.trust ?? 'unset', account, provider: plan.provider }] : [];
    });
  }

  private reserved(accountId: string): number {
    const now = this.now();
    const list = (this.reservations.get(accountId) ?? []).filter(until => until > now);
    if (list.length) this.reservations.set(accountId, list); else this.reservations.delete(accountId);
    return list.length;
  }

  runningOn(accountId: string, except?: string): number {
    let count = 0;
    for (const session of this.running) if (session !== except && this.sessions.get(session) === accountId) count++;
    return count;
  }

  active(accountId: string, except?: string): number { return this.runningOn(accountId, except) + this.reserved(accountId); }

  facts(member: PlanMember, key: KeyState, quota: QuotaView, except?: string): MemberFacts {
    return { signIn: key === 'ok' ? 'signed-in' : 'signed-out', quota, active: this.active(member.id, except), lastUsedAt: this.lastUsed.get(member.id) ?? null, capacity: concurrencyOf(member.account) };
  }

  /**
   * The members a launch may use, best first, and the others with the reason: no key (or one saved for another host),
   * quota used up, the person's card limit reached, a data level below the task's in strict mode.
   */
  rank(members: readonly PlanMember[], fact: (member: PlanMember) => { key: KeyState; quota: QuotaView }, request: { dataClass?: DataClass; mode?: DataClassMode; except?: string } = {}): { ranked: Ranked<PlanMember>[]; skipped: Skipped<PlanMember>[] } {
    const keyless: Skipped<PlanMember>[] = [];
    const keyed: PlanMember[] = [];
    const known = new Map<string, { key: KeyState; quota: QuotaView }>();
    for (const member of members) {
      const value = fact(member);
      known.set(member.id, value);
      if (value.key === 'ok') keyed.push(member);
      else keyless.push({ account: member, reason: value.key === 'missing' ? 'no key is saved for it (Accounts settings)' : 'its key was saved for another address; the person must save it again' });
    }
    const result = rankPool(keyed, member => this.facts(member, 'ok', known.get(member.id)!.quota, request.except), {
      ...(request.dataClass ? { dataClass: request.dataClass } : {}), ...(request.mode ? { mode: request.mode } : {})
    });
    return { ranked: result.ranked, skipped: [...keyless, ...result.skipped] };
  }

  /** A pick handed out (pick_account): counted for a minute so parallel picks spread over the accounts. */
  reserve(accountId: string): void {
    this.reservations.set(accountId, [...(this.reservations.get(accountId) ?? []), this.now() + RESERVATION_MS]);
  }

  /** The launch a pick was for: its reservation is used up. */
  consume(accountId: string): void {
    const list = this.reservations.get(accountId);
    if (list?.length) list.shift();
  }

  earlier(sessionId: string): string | undefined { return this.sessions.get(sessionId); }

  /** A card was prepared on the account. */
  started(sessionId: string, accountId: string): void {
    this.sessions.set(sessionId, accountId);
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    // Counted until its card ends; without card events nothing would ever release it.
    if (this.cardEvents()) this.running.add(sessionId);
    this.lastUsed.set(accountId, this.now());
  }

  /** `canvastty.sessions.event`. */
  sessionEvent(params: unknown): void {
    const event = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    const session = event.session && typeof event.session === 'object' ? event.session as Record<string, unknown> : {};
    if (typeof session.id !== 'string' || (event.type !== 'exited' && event.type !== 'closed')) return;
    this.running.delete(session.id);
    if (event.type === 'closed') this.sessions.delete(session.id);
  }

  forget(accountId: string): void {
    this.reservations.delete(accountId);
    this.lastUsed.delete(accountId);
    for (const [session, id] of this.sessions) if (id === accountId) { this.sessions.delete(session); this.running.delete(session); }
  }
}

/** "2 at their card limit (Low, High); 1 its quota is used up (Out)": the skipped accounts grouped by reason. */
export function summarizeSkipped(skipped: ReadonlyArray<{ account: { label: string }; reason: string }>): string {
  if (!skipped.length) return 'none is set up';
  const groups = new Map<string, string[]>();
  for (const entry of skipped) {
    const key = entry.reason.replace(/\s*\(.*\)$/u, '').replace(/^\d+ cards already run on it$/u, 'at the card limit the person set').trim();
    groups.set(key, [...(groups.get(key) ?? []), entry.account.label]);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length)
    .map(([reason, labels]) => `${labels.length} ${reason} (${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ', …' : ''})`).join('; ');
}

export const planLabel = (provider: PlanProvider): string => PLAN_INFO[provider].label;
export const planPoolHarness = (harness: string): harness is Harness => (PLAN_HARNESSES as readonly string[]).includes(harness);
export { PLAN_PROVIDERS };

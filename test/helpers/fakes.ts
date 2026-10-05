/**
 * In-memory implementations of the ports, for unit tests of application + http layers.
 * They implement the same contracts as the real adapters, minus the I/O.
 */
import type {
  AttemptStatusStore,
  BudgetStore,
  ExpiredReservation,
  RateLimitDecision,
  RateLimiter,
  ReserveRequest,
  ReserveResult,
  SettleResult,
  UsageLedger,
} from '../../src/domain/ports.js';
import type { UsageEntry } from '../../src/domain/types.js';

export class InMemoryAttemptStatusStore implements AttemptStatusStore {
  readonly closed = new Set<string>();
  failWith: Error | undefined;

  close(attemptId: string): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.closed.add(attemptId);
    return Promise.resolve();
  }
}

export class InMemoryUsageLedger implements UsageLedger {
  readonly rows = new Map<string, UsageEntry>();
  failWith: Error | undefined;

  readonly batches: number[] = [];

  record(entries: readonly UsageEntry[]): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.batches.push(entries.length);
    for (const entry of entries) {
      if (!this.rows.has(entry.requestId)) this.rows.set(entry.requestId, entry);
    }
    return Promise.resolve();
  }
}

/** Counting limiter: allows `limit` requests per subject, then denies with a fixed Retry-After. */
export class CountingRateLimiter implements RateLimiter {
  readonly consumed: string[] = [];
  failWith: Error | undefined;

  constructor(
    private readonly limit = Number.POSITIVE_INFINITY,
    private readonly retryAfterMs = 1_500,
  ) {}

  consume(subject: string): Promise<RateLimitDecision> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.consumed.push(subject);
    const used = this.consumed.filter((s) => s === subject).length;
    return Promise.resolve(
      used <= this.limit
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: this.retryAfterMs },
    );
  }
}

/**
 * In-memory BudgetStore with the same semantics as the Lua scripts (minus expiry/TTL; tests call
 * `expire()` to simulate an abandoned reservation for the sweeper).
 */
export class InMemoryBudgetStore implements BudgetStore {
  readonly budgets = new Map<string, number>();
  readonly closed = new Set<string>();
  readonly reservations = new Map<
    string,
    { attemptId: string; reserved: number; input: number; studentId: string; expired: boolean }
  >();
  failReserveWith: Error | undefined;
  failSettleWith: Error | undefined;
  readonly calls: string[] = [];

  constructor(private readonly minUsefulTokens = 16) {}

  reserve(r: ReserveRequest): Promise<ReserveResult> {
    this.calls.push(`reserve:${r.reservationId}`);
    if (this.failReserveWith) return Promise.reject(this.failReserveWith);
    if (this.closed.has(r.attemptId)) return Promise.resolve({ status: 'attempt_closed' });
    if (!this.budgets.has(r.attemptId)) this.budgets.set(r.attemptId, r.initialBudget);
    const remaining = this.budgets.get(r.attemptId) ?? 0;
    const effective = Math.min(r.maxTokensCap, remaining - r.inputTokens);
    if (effective <= this.minUsefulTokens) {
      return Promise.resolve({ status: 'budget_exhausted', remainingTokens: remaining });
    }
    const reserved = r.inputTokens + effective;
    this.budgets.set(r.attemptId, remaining - reserved);
    this.reservations.set(r.reservationId, {
      attemptId: r.attemptId,
      reserved,
      input: r.inputTokens,
      studentId: r.studentId,
      expired: false,
    });
    return Promise.resolve({
      status: 'reserved',
      reservedTokens: reserved,
      effectiveMaxTokens: effective,
    });
  }

  reconcile(attemptId: string, reservationId: string, actual: number): Promise<SettleResult> {
    this.calls.push(`reconcile:${reservationId}:${actual}`);
    return this.settle(attemptId, reservationId, actual);
  }

  release(attemptId: string, reservationId: string): Promise<SettleResult> {
    this.calls.push(`release:${reservationId}`);
    return this.settle(attemptId, reservationId, 0);
  }

  sweepExpired(limit: number): Promise<ExpiredReservation[]> {
    const out: ExpiredReservation[] = [];
    for (const [id, r] of this.reservations) {
      if (out.length >= limit) break;
      if (!r.expired) continue;
      this.reservations.delete(id);
      out.push({
        attemptId: r.attemptId,
        reservationId: id,
        studentId: r.studentId,
        inputTokens: r.input,
        reservedTokens: r.reserved,
        ageMs: 1,
      });
    }
    return Promise.resolve(out);
  }

  /** Simulate a reservation outliving its TTL (gateway crashed before settling). */
  expire(reservationId: string): void {
    const r = this.reservations.get(reservationId);
    if (r) r.expired = true;
  }

  private settle(attemptId: string, reservationId: string, actual: number): Promise<SettleResult> {
    if (this.failSettleWith) return Promise.reject(this.failSettleWith);
    const r = this.reservations.get(reservationId);
    if (!r) return Promise.resolve({ status: 'already_settled' });
    this.reservations.delete(reservationId);
    const charged = Math.min(Math.max(0, actual), r.reserved);
    const remaining = (this.budgets.get(attemptId) ?? 0) + r.reserved - charged;
    this.budgets.set(attemptId, remaining);
    return Promise.resolve({
      status: 'settled',
      reservedTokens: r.reserved,
      chargedTokens: charged,
      remainingTokens: remaining,
    });
  }
}

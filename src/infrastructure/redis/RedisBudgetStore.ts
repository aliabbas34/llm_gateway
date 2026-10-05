import type { Redis } from 'ioredis';
import type {
  BudgetStore,
  ExpiredReservation,
  ReserveRequest,
  ReserveResult,
  SettleResult,
} from '../../domain/ports.js';
import { DependencyUnavailableError } from '../../domain/errors.js';
import { failClosed } from './failClosed.js';
import { redisKeys } from './keys.js';

export interface BudgetPolicy {
  /** Reject a reservation whose effective completion size would be ≤ this (FR5). */
  readonly minUsefulTokens: number;
  /** Lifetime of a reservation before the sweeper may claim it (ADR-0011). */
  readonly reservationTtlMs: number;
  /** Lifetime of per-attempt keys, refreshed on every reserve (ADR-0016). */
  readonly attemptTtlSec: number;
}

/** Index member format: `<attemptId>|<reservationId>`. Attempt ids can't contain '|'. */
const member = (attemptId: string, reservationId: string) => `${attemptId}|${reservationId}`;

/**
 * Budget accounting in Redis. Correctness lives in the Lua scripts (atomic per attempt); this
 * class only shapes arguments and results, and keeps the global expiry index (ADR-0005).
 */
export class RedisBudgetStore implements BudgetStore {
  constructor(
    private readonly redis: Redis,
    private readonly policy: BudgetPolicy,
    private readonly now: () => number,
  ) {}

  async reserve(r: ReserveRequest): Promise<ReserveResult> {
    const { attemptId, reservationId } = r;
    // ADR-0005: write the expiry index BEFORE the reservation. If we crash in between, the index
    // points at nothing and the sweeper drops it. The reverse order could leave a reservation
    // that no sweeper ever finds (budget held forever). The score is provisional (local clock);
    // claim_expired re-checks the real expiry against Redis TIME.
    //
    // Both commands go in ONE pipeline (one round trip on the hot path). Commands on a connection
    // execute in order, so the index is still written first. They are not a transaction (the
    // index lives in another cluster slot): if the index write alone failed, the reservation is
    // undone immediately rather than left unindexed.
    const provisionalExpiry = this.now() + this.policy.reservationTtlMs;
    const indexMember = member(attemptId, reservationId);
    const [[indexError], [reserveError, reserveReply]] = await failClosed('reserve', async () => {
      const results = await this.redis
        .pipeline()
        .zadd(redisKeys.reservationExpiry, provisionalExpiry, indexMember)
        .gwReserve(
          redisKeys.status(attemptId),
          redisKeys.budget(attemptId),
          redisKeys.reservations(attemptId),
          r.initialBudget,
          r.maxTokensCap,
          r.inputTokens,
          this.policy.minUsefulTokens,
          this.policy.reservationTtlMs,
          reservationId,
          this.policy.attemptTtlSec,
          r.studentId,
          reservationId,
        )
        .exec();
      const [index, reserve] = results ?? [];
      if (index === undefined || reserve === undefined) throw new Error('reserve pipeline aborted');
      return [index, reserve] as const;
    });
    if (reserveError) {
      throw new DependencyUnavailableError('redis reserve failed', { cause: reserveError });
    }
    const reply = reserveReply as (string | number)[];
    if (indexError) {
      if (reply[0] === 'reserved')
        await this.release(attemptId, reservationId).catch(() => undefined);
      throw new DependencyUnavailableError('redis reserve index failed', { cause: indexError });
    }

    const [status, a, b] = reply;
    if (status === 'reserved') {
      return { status: 'reserved', reservedTokens: Number(a), effectiveMaxTokens: Number(b) };
    }
    // Rejected: the index entry is useless. Best effort; the sweeper drops it anyway.
    this.redis
      .zrem(redisKeys.reservationExpiry, member(attemptId, reservationId))
      .catch(() => undefined);
    if (status === 'attempt_closed') return { status: 'attempt_closed' };
    if (status === 'budget_exhausted')
      return { status: 'budget_exhausted', remainingTokens: Number(a) };
    throw new Error(`unexpected reserve reply: ${String(status)}`);
  }

  reconcile(attemptId: string, reservationId: string, actualTokens: number): Promise<SettleResult> {
    return this.settle(attemptId, reservationId, Math.max(0, Math.ceil(actualTokens)));
  }

  release(attemptId: string, reservationId: string): Promise<SettleResult> {
    return this.settle(attemptId, reservationId, 0);
  }

  async sweepExpired(limit: number): Promise<ExpiredReservation[]> {
    const index = redisKeys.reservationExpiry;
    const candidates = await failClosed('sweep scan', async () => {
      const [sec, usec] = await this.redis.time();
      const redisNow = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
      return this.redis.zrangebyscore(index, '-inf', redisNow, 'LIMIT', 0, limit);
    });

    const claimed: ExpiredReservation[] = [];
    for (const m of candidates) {
      const sep = m.indexOf('|');
      const attemptId = m.slice(0, sep);
      const reservationId = m.slice(sep + 1);
      const [status, ...rest] = await failClosed('sweep claim', () =>
        this.redis.gwClaimExpired(redisKeys.reservations(attemptId), reservationId),
      );
      if (status === 'not_expired') {
        // Provisional score was early (clock skew): move it to the real expiry and look later.
        await failClosed('sweep rescore', () => this.redis.zadd(index, 'XX', Number(rest[0]), m));
        continue;
      }
      await failClosed('sweep unindex', () => this.redis.zrem(index, m));
      if (status === 'claimed') {
        const [reserved, input, studentId, , ageMs] = rest;
        claimed.push({
          attemptId,
          reservationId,
          studentId: String(studentId),
          inputTokens: Number(input),
          reservedTokens: Number(reserved),
          ageMs: Number(ageMs),
        });
      }
    }
    return claimed;
  }

  private async settle(
    attemptId: string,
    reservationId: string,
    actual: number,
  ): Promise<SettleResult> {
    const [status, reserved, charged, remaining] = await failClosed('settle', () =>
      this.redis.gwSettle(
        redisKeys.budget(attemptId),
        redisKeys.reservations(attemptId),
        reservationId,
        actual,
      ),
    );
    if (status === 'already_settled') return { status: 'already_settled' };
    // The index entry is now stale; removing it is an optimisation (the sweeper would drop it).
    this.redis
      .zrem(redisKeys.reservationExpiry, member(attemptId, reservationId))
      .catch(() => undefined);
    return {
      status: 'settled',
      reservedTokens: Number(reserved),
      chargedTokens: Number(charged),
      remainingTokens: Number(remaining),
    };
  }
}

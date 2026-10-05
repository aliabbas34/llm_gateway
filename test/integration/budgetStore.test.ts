import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../../src/domain/errors.js';
import type { ExpiredReservation, ReserveRequest } from '../../src/domain/ports.js';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { RedisAttemptStatusStore } from '../../src/infrastructure/redis/RedisAttemptStatusStore.js';
import {
  RedisBudgetStore,
  type BudgetPolicy,
} from '../../src/infrastructure/redis/RedisBudgetStore.js';
import { connectTestRedis, deadRedis, uniqueAttemptId } from '../helpers/infra.js';

let redis: Redis;
beforeAll(async () => {
  redis = await connectTestRedis();
});
afterAll(async () => {
  await redis.quit();
});

const POLICY: BudgetPolicy = {
  minUsefulTokens: 16,
  reservationTtlMs: 60_000,
  attemptTtlSec: 3_600,
};
const store = (policy: Partial<BudgetPolicy> = {}, now = () => Date.now()) =>
  new RedisBudgetStore(redis, { ...POLICY, ...policy }, now);

let n = 0;
function req(attemptId: string, overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  n += 1;
  return {
    attemptId,
    reservationId: `req-${n}-${Math.random().toString(36).slice(2, 8)}`,
    studentId: 'stu|with|pipes',
    initialBudget: 1_000,
    maxTokensCap: 200,
    inputTokens: 50,
    ...overrides,
  };
}

const remaining = async (attemptId: string) => Number(await redis.get(redisKeys.budget(attemptId)));
const indexed = async (attemptId: string, rid: string) =>
  (await redis.zscore(redisKeys.reservationExpiry, `${attemptId}|${rid}`)) !== null;

describe('reserve (FR5)', () => {
  it('initialises from token_budget, reserves input + min(cap, remaining - input)', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    const res = await store().reserve(r);
    expect(res).toEqual({ status: 'reserved', reservedTokens: 250, effectiveMaxTokens: 200 });
    expect(await remaining(id)).toBe(750);
    expect(await indexed(id, r.reservationId)).toBe(true);
  });

  it('initialises only once (SETNX): a later token with a bigger token_budget cannot top up', async () => {
    const id = uniqueAttemptId();
    await store().reserve(req(id));
    await store().reserve(req(id, { initialBudget: 1_000_000 }));
    expect(await remaining(id)).toBe(500);
  });

  it('shrinks the completion to what is left near the end of the budget', async () => {
    const id = uniqueAttemptId();
    const res = await store().reserve(req(id, { initialBudget: 120, inputTokens: 50 }));
    expect(res).toEqual({ status: 'reserved', reservedTokens: 120, effectiveMaxTokens: 70 });
    expect(await remaining(id)).toBe(0);
  });

  it('rejects budget_exhausted at or below the useful minimum without touching the budget', async () => {
    const id = uniqueAttemptId();
    const r = req(id, { initialBudget: 66, inputTokens: 50 }); // effective = 16 = minimum
    expect(await store().reserve(r)).toEqual({ status: 'budget_exhausted', remainingTokens: 66 });
    expect(await remaining(id)).toBe(66);
    expect(await indexed(id, r.reservationId)).toBe(false); // index entry cleaned up
  });

  it('rejects a closed attempt before initialising anything (FR7)', async () => {
    const id = uniqueAttemptId();
    await new RedisAttemptStatusStore(redis, 60).close(id);
    expect(await store().reserve(req(id))).toEqual({ status: 'attempt_closed' });
    expect(await redis.exists(redisKeys.budget(id))).toBe(0);
  });

  it('refreshes per-attempt key TTLs', async () => {
    const id = uniqueAttemptId();
    await store().reserve(req(id));
    expect(await redis.ttl(redisKeys.budget(id))).toBeGreaterThan(3_500);
    expect(await redis.ttl(redisKeys.reservations(id))).toBeGreaterThan(3_500);
  });
});

describe('reconcile / release', () => {
  it('charges min(actual, reserved) and refunds the rest', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    await store().reserve(r); // reserved 250, remaining 750
    const s = await store().reconcile(id, r.reservationId, 90);
    expect(s).toEqual({
      status: 'settled',
      reservedTokens: 250,
      chargedTokens: 90,
      remainingTokens: 910,
    });
    expect(await indexed(id, r.reservationId)).toBe(false);
  });

  it('never charges more than reserved', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    await store().reserve(r);
    const s = await store().reconcile(id, r.reservationId, 99_999);
    expect(s).toMatchObject({ chargedTokens: 250, remainingTokens: 750 });
  });

  it('is idempotent: a second reconcile or release is a no-op', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    await store().reserve(r);
    await store().reconcile(id, r.reservationId, 100);
    expect(await store().reconcile(id, r.reservationId, 0)).toEqual({ status: 'already_settled' });
    expect(await store().release(id, r.reservationId)).toEqual({ status: 'already_settled' });
    expect(await remaining(id)).toBe(900);
  });

  it('release refunds everything', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    await store().reserve(r);
    expect(await store().release(id, r.reservationId)).toMatchObject({ chargedTokens: 0 });
    expect(await remaining(id)).toBe(1_000);
  });

  it('running streams can still settle after the attempt is closed (FR7)', async () => {
    const id = uniqueAttemptId();
    const r = req(id);
    await store().reserve(r);
    await new RedisAttemptStatusStore(redis, 60).close(id);
    expect(await store().reconcile(id, r.reservationId, 10)).toMatchObject({ status: 'settled' });
  });
});

describe('sweeper claims (ADR-0005)', () => {
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  /**
   * Sweep (with the given sweepers) until none of this attempt's reservations are left.
   * - Under load a sweep can see an entry whose provisional score is due but whose real expiry is a
   *   few ms later; it is re-scored and claimed by a later pass, so one pass is not enough.
   * - Other test files may run their own sweepers concurrently against the same global index, so
   *   assertions are about the end state and about never double-claiming, not about who won.
   */
  async function sweepUntilEmpty(
    attemptId: string,
    sweepers: RedisBudgetStore[],
  ): Promise<ExpiredReservation[]> {
    const got: ExpiredReservation[] = [];
    const deadline = Date.now() + 5_000;
    while ((await redis.hlen(redisKeys.reservations(attemptId))) > 0) {
      if (Date.now() > deadline) throw new Error('reservations not swept in time');
      const rounds = await Promise.all(sweepers.map((sw) => sw.sweepExpired(1_000)));
      got.push(...rounds.flat().filter((c) => c.attemptId === attemptId));
      await sleep(25);
    }
    return got;
  }

  it('claims an expired reservation, charges it in full, and makes late reconciles no-ops', async () => {
    const id = uniqueAttemptId();
    const s = store({ reservationTtlMs: 50 });
    const r = req(id);
    await s.reserve(r);
    await sleep(80);
    const claimed = await sweepUntilEmpty(id, [s]);
    for (const c of claimed) {
      expect(c).toEqual({
        attemptId: id,
        reservationId: r.reservationId,
        studentId: 'stu|with|pipes',
        inputTokens: 50,
        reservedTokens: 250,
        ageMs: expect.any(Number) as number,
      });
    }
    expect(await remaining(id)).toBe(750); // full charge: nothing refunded
    expect(await indexed(id, r.reservationId)).toBe(false);
    expect(await s.reconcile(id, r.reservationId, 10)).toEqual({ status: 'already_settled' });
  });

  it('two sweepers racing never claim a reservation twice', async () => {
    const id = uniqueAttemptId();
    const s = store({ reservationTtlMs: 30 });
    const rids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = req(id, { initialBudget: 1_000_000 });
      rids.push(r.reservationId);
      expect((await s.reserve(r)).status).toBe('reserved');
    }
    await sleep(60);
    const claimed = await sweepUntilEmpty(id, [store(), store()]);
    const mine = claimed.map((c) => c.reservationId);
    expect(new Set(mine).size).toBe(mine.length); // nobody claimed twice
    expect(mine.every((m) => rids.includes(m))).toBe(true);
    // Every reservation was charged in full exactly once, whoever claimed it.
    expect(await remaining(id)).toBe(1_000_000 - 20 * 250);
  });

  it('does not claim a live reservation even if its provisional index score says expired', async () => {
    const id = uniqueAttemptId();
    // This instance's clock is 10 minutes behind: its provisional score is far in the past.
    const skewed = store({ reservationTtlMs: 60_000 }, () => Date.now() - 600_000);
    const r = req(id);
    await skewed.reserve(r);
    const claimed = await skewed.sweepExpired(1_000);
    expect(claimed.find((c) => c.reservationId === r.reservationId)).toBeUndefined();
    // Re-scored to the authoritative expiry (≈ now + 60 s) and still settleable.
    const score = Number(
      await redis.zscore(redisKeys.reservationExpiry, `${id}|${r.reservationId}`),
    );
    expect(score).toBeGreaterThan(Date.now() + 50_000);
    expect(await skewed.reconcile(id, r.reservationId, 0)).toMatchObject({ status: 'settled' });
  });

  it('drops index entries that point at nothing (crash between index write and reserve)', async () => {
    const id = uniqueAttemptId();
    const orphan = `${id}|never-reserved`;
    await redis.zadd(redisKeys.reservationExpiry, Date.now() - 1_000, orphan);
    const claimed = await store().sweepExpired(1_000);
    expect(claimed.find((c) => c.attemptId === id)).toBeUndefined();
    expect(await redis.zscore(redisKeys.reservationExpiry, orphan)).toBeNull();
  });
});

describe('fail closed (NFR5)', () => {
  it('every operation fails with DependencyUnavailableError when Redis is down', async () => {
    const dead = deadRedis();
    dead.connect().catch(() => undefined);
    const s = new RedisBudgetStore(dead, POLICY, () => Date.now());
    const id = uniqueAttemptId();
    await expect(s.reserve(req(id))).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(s.reconcile(id, 'r', 1)).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(s.sweepExpired(10)).rejects.toBeInstanceOf(DependencyUnavailableError);
    dead.disconnect();
  });
});

/**
 * Budget is a HARD limit (NFR4), including under concurrency (FR5).
 * Many parallel reserves/settles on ONE attempt against real Redis; the invariants must hold:
 *   - remaining never goes negative (sampled while the storm runs),
 *   - total charged ≤ initial budget,
 *   - remaining + Σ charged = initial once everything is settled (nothing leaks or is invented).
 */
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { RedisBudgetStore } from '../../src/infrastructure/redis/RedisBudgetStore.js';
import { connectTestRedis, uniqueAttemptId } from '../helpers/infra.js';

let redis: Redis;
let store: RedisBudgetStore;
beforeAll(async () => {
  // These tests prove atomicity, not latency: a generous command timeout keeps a loaded CI box
  // from turning slow replies into fail-closed errors mid-storm.
  redis = await connectTestRedis({ REDIS_COMMAND_TIMEOUT_MS: '5000' });
  store = new RedisBudgetStore(
    redis,
    { minUsefulTokens: 16, reservationTtlMs: 60_000, attemptTtlSec: 3_600 },
    () => Date.now(),
  );
});
afterAll(async () => {
  await redis.quit();
});

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
}

describe('budget under concurrency', () => {
  it('100 parallel reserves on one attempt never over-reserve', async () => {
    const id = uniqueAttemptId();
    const INITIAL = 5_000;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        store.reserve({
          attemptId: id,
          reservationId: `r${i}`,
          studentId: 's',
          initialBudget: INITIAL,
          maxTokensCap: 200,
          inputTokens: 40,
        }),
      ),
    );
    const reserved = results.reduce(
      (sum, r) => sum + (r.status === 'reserved' ? r.reservedTokens : 0),
      0,
    );
    const left = Number(await redis.get(redisKeys.budget(id)));

    expect(left).toBeGreaterThanOrEqual(0);
    expect(reserved).toBeLessThanOrEqual(INITIAL);
    expect(reserved + left).toBe(INITIAL);
    expect(results.some((r) => r.status === 'budget_exhausted')).toBe(true); // the limit was hit
  });

  it('a 200-request reserve/settle storm keeps the invariants (seeded random workload)', async () => {
    const id = uniqueAttemptId();
    const INITIAL = 20_000;
    const rand = rng(7);
    let charged = 0;
    let minObserved = Number.POSITIVE_INFINITY;
    // An object, not a let: the sampler loop reads a flag that another task flips.
    const state = { sampling: true };

    const sampler = (async () => {
      while (state.sampling) {
        const v = await redis.get(redisKeys.budget(id));
        if (v !== null) minObserved = Math.min(minObserved, Number(v));
        await new Promise((r) => setImmediate(r));
      }
    })();

    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, Math.floor(rand() * 20)));
        const res = await store.reserve({
          attemptId: id,
          reservationId: `s${i}`,
          studentId: 's',
          initialBudget: INITIAL,
          maxTokensCap: 64 + Math.floor(rand() * 400),
          inputTokens: 10 + Math.floor(rand() * 200),
        });
        if (res.status !== 'reserved') return;
        await new Promise((r) => setTimeout(r, Math.floor(rand() * 20)));
        // Some requests report more than they reserved (bad estimate); some release; some
        // reconcile twice (retry) — all must be safe.
        const roll = rand();
        const settle =
          roll < 0.15
            ? await store.release(id, `s${i}`)
            : await store.reconcile(id, `s${i}`, Math.floor(rand() * res.reservedTokens * 1.5));
        if (settle.status === 'settled') charged += settle.chargedTokens;
        if (roll > 0.9) {
          expect(await store.reconcile(id, `s${i}`, 1)).toEqual({ status: 'already_settled' });
        }
      }),
    );
    state.sampling = false;
    await sampler;

    const left = Number(await redis.get(redisKeys.budget(id)));
    expect(minObserved).toBeGreaterThanOrEqual(0);
    expect(charged).toBeLessThanOrEqual(INITIAL);
    expect(left + charged).toBe(INITIAL);
    expect(await redis.hlen(redisKeys.reservations(id))).toBe(0);
  });
});

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../../src/domain/errors.js';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { RedisRateLimiter } from '../../src/infrastructure/redis/RedisRateLimiter.js';
import { connectTestRedis, deadRedis, uniqueAttemptId } from '../helpers/infra.js';

let redis: Redis;
beforeAll(async () => {
  redis = await connectTestRedis();
});
afterAll(async () => {
  await redis.quit();
});

const limiter = (limit: number, periodMs: number) =>
  new RedisRateLimiter(redis, { limit, periodMs }, redisKeys.attemptRate);

describe('RedisRateLimiter (GCRA, FR4)', () => {
  it('allows a burst of exactly `limit`, then denies with a Retry-After of one emission interval', async () => {
    const rl = limiter(5, 60_000); // emission interval = 12 s
    const id = uniqueAttemptId();
    const decisions = [];
    for (let i = 0; i < 6; i++) decisions.push(await rl.consume(id));
    expect(decisions.slice(0, 5).every((d) => d.allowed)).toBe(true);
    expect(decisions[5]?.allowed).toBe(false);
    expect(decisions[5]?.retryAfterMs).toBeGreaterThan(11_000);
    expect(decisions[5]?.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it('a denied request does not consume quota, and capacity refills over time', async () => {
    const rl = limiter(2, 400); // one slot every 200 ms
    const id = uniqueAttemptId();
    expect((await rl.consume(id)).allowed).toBe(true);
    expect((await rl.consume(id)).allowed).toBe(true);
    const denied = await rl.consume(id);
    expect(denied.allowed).toBe(false);
    await new Promise((r) => setTimeout(r, denied.retryAfterMs + 20));
    expect((await rl.consume(id)).allowed).toBe(true);
    expect((await rl.consume(id)).allowed).toBe(false);
  });

  it('is atomic under concurrency: 50 parallel requests against limit 10 → exactly 10 allowed', async () => {
    const rl = limiter(10, 60_000);
    const id = uniqueAttemptId();
    const results = await Promise.all(Array.from({ length: 50 }, () => rl.consume(id)));
    expect(results.filter((d) => d.allowed)).toHaveLength(10);
  });

  it('isolates subjects and sets a TTL so idle keys disappear', async () => {
    const rl = limiter(1, 60_000);
    const a = uniqueAttemptId();
    const b = uniqueAttemptId();
    expect((await rl.consume(a)).allowed).toBe(true);
    expect((await rl.consume(b)).allowed).toBe(true);
    const ttl = await redis.pttl(redisKeys.attemptRate(a));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('works for IP keys (IPv6 included)', async () => {
    const rl = new RedisRateLimiter(redis, { limit: 1, periodMs: 60_000 }, redisKeys.ipRate);
    const ip = `2001:db8::${Math.floor(Math.random() * 0xffff).toString(16)}`;
    expect((await rl.consume(ip)).allowed).toBe(true);
    expect((await rl.consume(ip)).allowed).toBe(false);
  });

  it('fails closed when Redis is unreachable', async () => {
    const dead = deadRedis();
    dead.connect().catch(() => undefined);
    const rl = new RedisRateLimiter(dead, { limit: 100, periodMs: 60_000 }, redisKeys.ipRate);
    await expect(rl.consume('10.0.0.1')).rejects.toBeInstanceOf(DependencyUnavailableError);
    dead.disconnect();
  });
});

describe('RedisRateLimiter edge cases', () => {
  it('a limit so high that the emission interval underflows double precision never errors', async () => {
    // 1e9/min → emission 0.00006 ms, below the ~0.0002 ms resolution of epoch-ms doubles.
    // Regression: SET … PX 0 was rejected by Redis and every request failed closed with 503.
    const rl = limiter(1_000_000_000, 60_000);
    const id = uniqueAttemptId();
    for (let i = 0; i < 200; i++) expect((await rl.consume(id)).allowed).toBe(true);
  });
});

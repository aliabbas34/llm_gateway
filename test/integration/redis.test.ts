import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../../src/domain/errors.js';
import { ATTEMPT_CLOSED, redisKeys } from '../../src/infrastructure/redis/keys.js';
import { RedisAttemptStatusStore } from '../../src/infrastructure/redis/RedisAttemptStatusStore.js';
import { RedisHealthCheck } from '../../src/infrastructure/redis/RedisHealthCheck.js';
import { connectTestRedis, deadRedis, uniqueAttemptId } from '../helpers/infra.js';

let redis: Redis;
beforeAll(async () => {
  redis = await connectTestRedis();
});
afterAll(async () => {
  await redis.quit();
});

describe('RedisAttemptStatusStore (FR7)', () => {
  it('writes the closed flag with the attempt TTL, idempotently', async () => {
    const store = new RedisAttemptStatusStore(redis, 3_600);
    const id = uniqueAttemptId();
    await store.close(id);
    await store.close(id);
    expect(await redis.get(redisKeys.status(id))).toBe(ATTEMPT_CLOSED);
    const ttl = await redis.ttl(redisKeys.status(id));
    expect(ttl).toBeGreaterThan(3_500);
    expect(ttl).toBeLessThanOrEqual(3_600);
  });
});

describe('fail closed when Redis is down (NFR5)', () => {
  it('turns connection failure into DependencyUnavailableError quickly', async () => {
    const dead = deadRedis();
    dead.connect().catch(() => undefined);
    const store = new RedisAttemptStatusStore(dead, 60);
    const started = Date.now();
    await expect(store.close(uniqueAttemptId())).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(Date.now() - started).toBeLessThan(1_000);
    dead.disconnect();
  });

  it('health check passes against live Redis and fails against a dead one', async () => {
    await expect(new RedisHealthCheck(redis).check()).resolves.toBeUndefined();
    const dead = deadRedis();
    dead.connect().catch(() => undefined);
    await expect(new RedisHealthCheck(dead).check()).rejects.toThrow();
    dead.disconnect();
  });
});

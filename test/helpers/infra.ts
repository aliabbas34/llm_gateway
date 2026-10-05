import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { createPgPool } from '../../src/infrastructure/postgres/pool.js';
import { createRedisClient } from '../../src/infrastructure/redis/client.js';
import { createLogger } from '../../src/observability/logger.js';
import { testConfig } from './testConfig.js';

const silent = createLogger({ log: { level: 'silent' } });

/** A connected Redis client configured exactly like production (fail-closed options). */
export async function connectTestRedis(overrides: Record<string, string> = {}): Promise<Redis> {
  const redis = createRedisClient(testConfig(overrides), silent);
  await redis.connect();
  return redis;
}

/** A Redis client pointed at a port where nothing listens: every command must fail fast. */
export function deadRedis(): Redis {
  return createRedisClient(testConfig({ REDIS_URL: 'redis://127.0.0.1:1' }), silent);
}

export function testPgPool(overrides: Record<string, string> = {}): pg.Pool {
  return createPgPool(testConfig(overrides), silent);
}

/** Unique attempt id per test so parallel test files never share Redis keys or ledger rows. */
export function uniqueAttemptId(prefix = 'att'): string {
  return `${prefix}-${randomUUID().slice(0, 18)}`;
}

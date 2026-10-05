/**
 * Vitest globalSetup for projects that need real infrastructure. Fails fast with a helpful
 * message when docker compose is not running, then applies migrations once per run.
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import { migrateUp } from '../../src/infrastructure/postgres/migrate.js';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './testConfig.js';

export default async function setup(): Promise<void> {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Redis not reachable at ${TEST_REDIS_URL}. Run "docker compose up -d --wait" first.`,
      { cause: err },
    );
  } finally {
    redis.disconnect();
  }

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Postgres not reachable at ${TEST_DATABASE_URL}. Run "docker compose up -d --wait" first.`,
      { cause: err },
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  await migrateUp(TEST_DATABASE_URL);
}

/**
 * NFR4 through the whole stack: 60 parallel chat requests for ONE attempt against a real gateway
 * (Redis + Postgres + fake provider over HTTP). Whatever mix of 200s and 403s comes back:
 *   Σ ledger.charged ≤ initial budget, and Redis remaining + Σ charged = initial.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, type RealGateway } from '../helpers/realGateway.js';
import { TEST_DATABASE_URL } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

let g: RealGateway;
let db: pg.Pool;
beforeAll(async () => {
  // A few ms between words so streams overlap and reservations are held concurrently.
  g = await startRealGateway({ PRIMARY_MODEL: 'fake:ok?words=40&gap=2' });
  db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
afterAll(async () => {
  await g.stop();
  await db.end();
});

describe('hard budget limit under 60 concurrent requests (e2e)', () => {
  it('never charges more than the initial budget', async () => {
    const attemptId = uniqueAttemptId();
    const INITIAL = 3_000;
    const token = await testToken({ attemptId, tokenBudget: INITIAL, maxTokensCap: 128 });

    const statuses = await Promise.all(
      Array.from({ length: 60 }, async () => {
        const res = await fetch(`${g.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Explain the codebase.' }] }),
        });
        await res.text();
        return res.status;
      }),
    );

    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    expect(statuses.filter((s) => s === 403).length).toBeGreaterThan(0); // the limit was reached
    expect(statuses.every((s) => s === 200 || s === 403)).toBe(true);

    await g.gateway.usage.flush();
    const { rows } = await db.query<{ charged: string; n: string }>(
      'SELECT COALESCE(SUM(charged_tokens), 0) AS charged, COUNT(*) AS n FROM usage_ledger WHERE attempt_id = $1',
      [attemptId],
    );
    const charged = Number(rows[0]?.charged);
    const remaining = Number(await g.gateway.redis.get(redisKeys.budget(attemptId)));

    expect(Number(rows[0]?.n)).toBe(60); // one ledger row per request (FR8)
    expect(charged).toBeLessThanOrEqual(INITIAL);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining + charged).toBe(INITIAL);
    expect(await g.gateway.redis.hlen(redisKeys.reservations(attemptId))).toBe(0);
  });
});

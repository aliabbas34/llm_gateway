/**
 * Budget happy path end to end (FR5, FR8): real gateway composition, real Redis and Postgres,
 * fake provider over HTTP.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, type RealGateway } from '../helpers/realGateway.js';
import { sseText } from '../helpers/sse.js';
import { TEST_DATABASE_URL, TEST_SERVICE_API_KEY } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

let g: RealGateway;
let db: pg.Pool;
beforeAll(async () => {
  g = await startRealGateway();
  db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
afterAll(async () => {
  await g.stop();
  await db.end();
});

async function chat(token: string, content = 'hello') {
  const res = await fetch(`${g.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  return { status: res.status, body: await res.text(), requestId: res.headers.get('x-request-id') };
}

async function ledgerRow(requestId: string | null) {
  await g.gateway.usage.flush();
  const res = await db.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

describe('budget happy path (e2e)', () => {
  it('streams, charges the provider-reported usage, and writes one ledger row', async () => {
    const attemptId = uniqueAttemptId();
    const res = await chat(await testToken({ attemptId, tokenBudget: 5_000, maxTokensCap: 256 }));
    expect(res.status).toBe(200);
    expect(sseText(res.body)).toBe('w1 w2 w3 w4 w5');

    const row = await ledgerRow(res.requestId);
    expect(row).toMatchObject({
      attempt_id: attemptId,
      student_id: 'stu-1',
      provider: 'fake',
      model: 'ok',
      outcome: 'completed',
      output_tokens: 5,
      failover_count: 0,
    });
    const charged = Number(row?.charged_tokens);
    expect(charged).toBe(Number(row?.input_tokens) + 5);
    // Redis agrees with the ledger: remaining = initial - charged, no open reservations.
    expect(Number(await g.gateway.redis.get(redisKeys.budget(attemptId)))).toBe(5_000 - charged);
    expect(await g.gateway.redis.hlen(redisKeys.reservations(attemptId))).toBe(0);
  });

  it('stops the chat when the allowance runs out: 403 budget_exhausted + ledger row', async () => {
    const attemptId = uniqueAttemptId();
    const token = await testToken({ attemptId, tokenBudget: 600, maxTokensCap: 256 });
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await chat(token);
      statuses.push(r.status);
      if (r.status === 403) {
        expect(JSON.parse(r.body)).toMatchObject({ error: { code: 'budget_exhausted' } });
        expect((await ledgerRow(r.requestId))?.outcome).toBe('budget_exhausted');
        break;
      }
    }
    expect(statuses.at(-1)).toBe(403);
    expect(Number(await g.gateway.redis.get(redisKeys.budget(attemptId)))).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('close endpoint → new requests 403 attempt_closed (FR7)', async () => {
    const attemptId = uniqueAttemptId();
    const token = await testToken({ attemptId });
    expect((await chat(token)).status).toBe(200);
    const close = await fetch(`${g.url}/v1/attempts/${attemptId}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_SERVICE_API_KEY}` },
    });
    expect(close.status).toBe(200);
    const after = await chat(token);
    expect(after.status).toBe(403);
    expect(JSON.parse(after.body)).toMatchObject({ error: { code: 'attempt_closed' } });
  });

  it('a running stream finishes normally after its attempt is closed (FR7)', async () => {
    const slow = await startRealGateway({ PRIMARY_MODEL: 'fake:ok?words=20&gap=25' });
    try {
      const attemptId = uniqueAttemptId();
      const token = await testToken({ attemptId });
      const send = () =>
        fetch(`${slow.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
      const res = await send();
      expect(res.status).toBe(200); // headers arrive with the first token
      const close = await fetch(`${slow.url}/v1/attempts/${attemptId}/close`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_SERVICE_API_KEY}` },
      });
      expect(close.status).toBe(200);
      const body = await res.text(); // the in-flight stream runs to completion
      expect(sseText(body).split(' ')).toHaveLength(20);
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
      expect((await send()).status).toBe(403); // but no new request gets through
    } finally {
      await slow.stop();
    }
  });

  it('readyz is green with Redis and Postgres reachable', async () => {
    const res = await fetch(`${g.url}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { redis: 'up', postgres: 'up' } });
  });
});

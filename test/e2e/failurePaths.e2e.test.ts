/**
 * Every failure path from the spec, through the real gateway composition, with its observable
 * consequences in Redis and the ledger. (Crash recovery has its own file: it kills a process.)
 */
import http from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, type RealGateway } from '../helpers/realGateway.js';
import { ssePayloads, sseText } from '../helpers/sse.js';
import { TEST_DATABASE_URL } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

let db: pg.Pool;
beforeAll(() => {
  db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
afterAll(async () => {
  await db.end();
});

async function ledgerRow(g: RealGateway, requestId: string | null) {
  await g.gateway.usage.flush();
  const res = await db.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
  return res.rows[0] as Record<string, number | string | null> | undefined;
}

async function chat(g: RealGateway, token: string) {
  const res = await fetch(`${g.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.text(),
    requestId: res.headers.get('x-request-id'),
  };
}

/** Wait (bounded) until a reservation is settled and its ledger row exists. */
async function settledRow(g: RealGateway, attemptId: string, requestId: string | null) {
  for (let i = 0; i < 100; i++) {
    const open = await g.gateway.redis.hlen(redisKeys.reservations(attemptId));
    const row = await ledgerRow(g, requestId);
    if (open === 0 && row) return row;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('reservation was not settled');
}

describe('client disconnect', () => {
  let g: RealGateway;
  beforeAll(async () => {
    g = await startRealGateway({ PRIMARY_MODEL: 'fake:ok?words=300&gap=20' });
  });
  afterAll(async () => {
    await g.stop();
  });

  it('aborts upstream and charges input + what was streamed, capped at the reservation', async () => {
    const attemptId = uniqueAttemptId();
    const token = await testToken({ attemptId, tokenBudget: 10_000, maxTokensCap: 1_000 });
    const cancelled = g.upstream.nextAbortedResponse();
    const requestId = await new Promise<string>((resolve) => {
      const req = http.request(
        `${g.url}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (res) => {
          let chunks = 0;
          res.on('data', () => {
            chunks += 1;
            if (chunks === 3) {
              req.destroy();
              resolve(String(res.headers['x-request-id']));
            }
          });
        },
      );
      req.on('error', () => undefined);
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    });
    await cancelled;

    const row = await settledRow(g, attemptId, requestId);
    expect(row.outcome).toBe('client_disconnected');
    expect(Number(row.output_tokens)).toBeGreaterThan(0);
    expect(Number(row.output_tokens)).toBeLessThan(300); // far fewer than the full answer
    expect(Number(row.charged_tokens)).toBeLessThanOrEqual(Number(row.reserved_tokens));
    expect(Number(row.charged_tokens)).toBe(Number(row.input_tokens) + Number(row.output_tokens));
    const remaining = Number(await g.gateway.redis.get(redisKeys.budget(attemptId)));
    expect(remaining).toBe(10_000 - Number(row.charged_tokens));
  });
});

describe('provider error mid-stream', () => {
  let g: RealGateway;
  beforeAll(async () => {
    g = await startRealGateway({ PRIMARY_MODEL: 'fake:midstream-error' });
  });
  afterAll(async () => {
    await g.stop();
  });

  it('sends an SSE error event, closes, reconciles, and records stream_error', async () => {
    const attemptId = uniqueAttemptId();
    const res = await chat(g, await testToken({ attemptId, tokenBudget: 10_000 }));
    expect(res.status).toBe(200);
    expect(sseText(res.body)).toBe('w1 w2');
    expect(ssePayloads(res.body).at(-1)).toMatchObject({ error: { code: 'upstream_error' } });
    expect(res.body).not.toContain('[DONE]');

    const row = await settledRow(g, attemptId, res.requestId);
    expect(row).toMatchObject({ outcome: 'stream_error' });
    expect(Number(row.charged_tokens)).toBeGreaterThan(0);
  });

  it('a dropped upstream connection mid-stream is handled the same way', async () => {
    const drop = await startRealGateway({ PRIMARY_MODEL: 'fake:midstream-drop' });
    try {
      const attemptId = uniqueAttemptId();
      const res = await chat(drop, await testToken({ attemptId }));
      expect(res.status).toBe(200);
      expect(ssePayloads(res.body).at(-1)).toMatchObject({ error: { code: 'upstream_error' } });
      expect((await settledRow(drop, attemptId, res.requestId)).outcome).toBe('stream_error');
    } finally {
      await drop.stop();
    }
  });
});

describe('Redis down → fail closed (NFR5)', () => {
  let g: RealGateway;
  beforeAll(async () => {
    g = await startRealGateway({ REDIS_URL: 'redis://127.0.0.1:1' }, { waitForReady: false });
  });
  afterAll(async () => {
    await g.stop();
  });

  it('answers 503 + Retry-After, never streams, and readyz fails', async () => {
    const res = await chat(g, await testToken());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(g.upstream.requests).toHaveLength(0); // no tokens were spent without a budget check

    const ready = await fetch(`${g.url}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { redis: 'down', postgres: 'up' } });
    expect((await fetch(`${g.url}/healthz`)).status).toBe(200); // alive, just not ready
  });
});

describe('Postgres down → stream still served', () => {
  let g: RealGateway;
  beforeAll(async () => {
    g = await startRealGateway(
      { DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' },
      { waitForReady: false },
    );
    await new Promise((r) => setTimeout(r, 300)); // let Redis connect
  });
  afterAll(async () => {
    await g.stop();
  });

  it('streams normally, logs the ledger failure (ids only), and readyz fails', async () => {
    const attemptId = uniqueAttemptId();
    const res = await chat(g, await testToken({ attemptId }));
    expect(res.status).toBe(200);
    expect(sseText(res.body)).toBe('w1 w2 w3 w4 w5');
    // Budget accounting is unaffected: it lives in Redis.
    expect(await g.gateway.redis.hlen(redisKeys.reservations(attemptId))).toBe(0);

    await g.gateway.usage.flush();
    const failure = g.logs.records.find((r) => r.msg === 'usage ledger write failed');
    expect(failure).toMatchObject({
      level: 'error',
      request_id: res.requestId,
      attempt_id: attemptId,
    });

    const ready = await fetch(`${g.url}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { redis: 'up', postgres: 'down' } });
  });
});

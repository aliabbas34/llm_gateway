/** FR6 over real HTTP: the gateway composition + the fake provider's misbehaviour scenarios. */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function withGateway(env: Record<string, string>, fn: (g: RealGateway) => Promise<void>) {
  const g = await startRealGateway(env);
  try {
    await fn(g);
  } finally {
    await g.stop();
  }
}

async function chat(g: RealGateway) {
  const res = await fetch(`${g.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await testToken({ attemptId: uniqueAttemptId() })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  return { status: res.status, body: await res.text(), requestId: res.headers.get('x-request-id') };
}

async function ledgerRow(g: RealGateway, requestId: string | null) {
  await g.gateway.usage.flush();
  const res = await db.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

describe('failover (FR6, e2e)', () => {
  it('primary 503 → fallback serves the stream; the client never sees the failure', async () => {
    await withGateway(
      { PRIMARY_MODEL: 'fake:status-503', FALLBACK_MODELS: 'fake:ok?words=3' },
      async (g) => {
        const res = await chat(g);
        expect(res.status).toBe(200);
        expect(sseText(res.body)).toBe('w1 w2 w3');
        expect(g.upstream.requests.map((r) => r.model)).toEqual(['status-503', 'ok?words=3']);
        expect(await ledgerRow(g, res.requestId)).toMatchObject({
          outcome: 'completed',
          model: 'ok?words=3',
          failover_count: 1,
        });
      },
    );
  });

  it('primary 429 → fallback', async () => {
    await withGateway(
      { PRIMARY_MODEL: 'fake:status-429', FALLBACK_MODELS: 'fake:ok' },
      async (g) => {
        expect((await chat(g)).status).toBe(200);
      },
    );
  });

  it('primary never sends headers → TTFT timeout → fallback; the hung request is cancelled', async () => {
    await withGateway(
      {
        PRIMARY_MODEL: 'fake:hang-headers',
        FALLBACK_MODELS: 'fake:ok',
        PROVIDER_TTFT_TIMEOUT_MS: '300',
      },
      async (g) => {
        const cancelled = g.upstream.nextAbortedResponse();
        const started = Date.now();
        const res = await chat(g);
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(2_000);
        await expect(cancelled).resolves.toMatchObject({ model: 'hang-headers' });
        const log = g.logs.records.find((r) => r.msg === 'chat completion finished');
        expect(log).toMatchObject({ failover_count: 1, failover_reasons: ['timeout'] });
      },
    );
  });

  it('a non-retryable 400 does not fail over → 502 JSON, fallback never called', async () => {
    await withGateway(
      { PRIMARY_MODEL: 'fake:status-400', FALLBACK_MODELS: 'fake:ok' },
      async (g) => {
        const res = await chat(g);
        expect(res.status).toBe(502);
        expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'upstream_unavailable' } });
        expect(g.upstream.requests.map((r) => r.model)).toEqual(['status-400']);
      },
    );
  });

  it('all candidates down → 502 and a released reservation (charged 0)', async () => {
    await withGateway(
      { PRIMARY_MODEL: 'fake:status-503', FALLBACK_MODELS: 'fake:status-502' },
      async (g) => {
        const res = await chat(g);
        expect(res.status).toBe(502);
        expect(await ledgerRow(g, res.requestId)).toMatchObject({
          outcome: 'upstream_error',
          charged_tokens: 0,
          failover_count: 1,
        });
      },
    );
  });

  it('stall after the first byte → idle timeout → upstream_timeout event, no failover', async () => {
    await withGateway(
      {
        PRIMARY_MODEL: 'fake:hang-body',
        FALLBACK_MODELS: 'fake:ok',
        PROVIDER_IDLE_TIMEOUT_MS: '300',
      },
      async (g) => {
        const res = await chat(g);
        expect(res.status).toBe(200);
        expect(sseText(res.body)).toBe('w1');
        expect(ssePayloads(res.body).at(-1)).toMatchObject({ error: { code: 'upstream_timeout' } });
        expect(g.upstream.requests.map((r) => r.model)).toEqual(['hang-body']);
      },
    );
  });
});

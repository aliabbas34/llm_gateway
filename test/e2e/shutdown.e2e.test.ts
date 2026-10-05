/**
 * Graceful shutdown: readyz → 503, stop accepting, drain streams up to the deadline, abort the
 * rest (each settles its reservation), close Redis and Postgres, exit 0.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { connectTestRedis, uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, waitUntilReady, type RealGateway } from '../helpers/realGateway.js';
import { ssePayloads, sseText } from '../helpers/sse.js';
import { TEST_DATABASE_URL, baseTestEnv } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

let db: pg.Pool;
beforeAll(() => {
  db = new pg.Pool({ connectionString: TEST_DATABASE_URL });
});
afterAll(async () => {
  await db.end();
});

/** Start a streaming request; resolves once the first bytes arrived, with a body promise. */
function startStream(url: string, token: string) {
  return new Promise<{ requestId: string; body: Promise<string> }>((resolve, reject) => {
    const req = http.request(
      `${url}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        let text = '';
        const body = new Promise<string>((done) => {
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => {
            done(text);
          });
          res.on('error', () => {
            done(text);
          });
          res.on('close', () => {
            done(text);
          });
        });
        res.once('data', () => {
          resolve({ requestId: String(res.headers['x-request-id']), body });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
  });
}

async function ledgerRow(requestId: string) {
  const res = await db.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

describe('graceful shutdown (in-process)', () => {
  let g: RealGateway;
  afterAll(async () => {
    await g.stop();
  });

  it('in-flight streams finish within the drain window; readiness and new work are refused', async () => {
    g = await startRealGateway({
      PRIMARY_MODEL: 'fake:ok?words=40&gap=20', // ~0.8 s
      SHUTDOWN_DRAIN_TIMEOUT_MS: '5000',
    });
    const attemptId = uniqueAttemptId();
    const stream = await startStream(g.url, await testToken({ attemptId }));

    const shutdown = g.gateway.shutdown('test');
    // Immediately: draining (readyz answers 503: see HealthService tests) and no new connections
    // are accepted, while the in-flight stream keeps going.
    expect(g.gateway.lifecycle.isDraining()).toBe(true);
    await expect(fetch(`${g.url}/readyz`)).rejects.toThrow();

    const body = await stream.body;
    expect(sseText(body).split(' ')).toHaveLength(40); // finished normally
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await shutdown;

    // quit() resolves on Redis' OK; the socket closes a moment later.
    await expect.poll(() => g.gateway.redis.status).toBe('end');
    expect(g.gateway.pgPool.ended).toBe(true);
    expect(await ledgerRow(stream.requestId)).toMatchObject({ outcome: 'completed' });
  });
});

describe('graceful shutdown: drain deadline', () => {
  let g: RealGateway;
  afterAll(async () => {
    await g.stop();
  });

  it('aborts streams still running at the deadline, settling each one', async () => {
    g = await startRealGateway({
      PRIMARY_MODEL: 'fake:ok?words=1000&gap=20', // ~20 s
      SHUTDOWN_DRAIN_TIMEOUT_MS: '500',
    });
    const attemptId = uniqueAttemptId();
    const redis = await connectTestRedis();
    try {
      const stream = await startStream(g.url, await testToken({ attemptId, tokenBudget: 50_000 }));
      const started = Date.now();
      await g.gateway.shutdown('test');
      expect(Date.now() - started).toBeLessThan(5_000);

      const body = await stream.body;
      expect(ssePayloads(body).at(-1)).toMatchObject({ error: { code: 'shutting_down' } });
      expect(body).not.toContain('[DONE]');

      const row = await ledgerRow(stream.requestId);
      expect(row).toMatchObject({ outcome: 'shutdown_aborted' });
      expect(Number(row?.charged_tokens)).toBeGreaterThan(0);
      expect(Number(row?.charged_tokens)).toBeLessThanOrEqual(Number(row?.reserved_tokens));
      expect(await redis.hlen(redisKeys.reservations(attemptId))).toBe(0); // settled, not leaked
    } finally {
      await redis.quit();
    }
  });
});

// On Windows, ChildProcess.kill('SIGTERM') is TerminateProcess (no handler runs), so the real
// signal path is verified on Linux (CI); the shutdown sequence itself is covered above everywhere.
describe.skipIf(process.platform === 'win32')('SIGTERM to a real process', () => {
  let upstream: FakeProviderServer;
  beforeAll(async () => {
    upstream = await startFakeProviderServer();
  });
  afterAll(async () => {
    await upstream.close();
  });

  it('drains, aborts the straggler, settles it, and exits 0', { timeout: 60_000 }, async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r));

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        ...baseTestEnv,
        LOG_LEVEL: 'warn',
        HOST: '127.0.0.1',
        PORT: String(port),
        METRICS_PORT: '0',
        FAKE_PROVIDER_BASE_URL: upstream.url,
        PRIMARY_MODEL: 'fake:ok?words=1000&gap=20',
        FALLBACK_MODELS: '',
        SHUTDOWN_DRAIN_TIMEOUT_MS: '500',
      },
      stdio: 'ignore',
    });
    const url = `http://127.0.0.1:${port}`;
    await waitUntilReady(url, 20_000);

    const stream = await startStream(url, await testToken({ attemptId: uniqueAttemptId() }));
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    child.kill('SIGTERM');

    expect(await exited).toBe(0);
    expect(ssePayloads(await stream.body).at(-1)).toMatchObject({
      error: { code: 'shutting_down' },
    });
    expect(await ledgerRow(stream.requestId)).toMatchObject({ outcome: 'shutdown_aborted' });
  });
});

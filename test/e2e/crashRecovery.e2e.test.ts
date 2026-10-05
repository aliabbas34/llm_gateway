/**
 * Gateway crash (failure path): a real gateway PROCESS is SIGKILLed mid-stream, so it never
 * reconciles. Its reservation must not hold the budget forever: once the reservation TTL passes,
 * a sweeper (as on any surviving instance) claims it, charges it in full, and writes an
 * `expired_unreconciled` ledger row.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import { ReservationSweeper } from '../../src/application/ReservationSweeper.js';
import { UsageRecorder } from '../../src/application/UsageRecorder.js';
import { PgUsageLedger } from '../../src/infrastructure/postgres/PgUsageLedger.js';
import { redisKeys } from '../../src/infrastructure/redis/keys.js';
import { RedisBudgetStore } from '../../src/infrastructure/redis/RedisBudgetStore.js';
import { connectTestRedis, testPgPool, uniqueAttemptId } from '../helpers/infra.js';
import { waitUntilReady } from '../helpers/realGateway.js';
import { baseTestEnv } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

// The doomed instance must still be mid-stream when killed, even on a loaded CI machine, so its
// max stream duration is generous; the TTL must then be at least that + 5 s (ADR-0011).
const MAX_STREAM_MS = 5_000;
const TTL_MS = 10_000;

let upstream: FakeProviderServer;
let redis: Redis;
let pool: pg.Pool;
let child: ChildProcess | undefined;

beforeAll(async () => {
  upstream = await startFakeProviderServer();
  redis = await connectTestRedis();
  pool = testPgPool();
});
afterAll(async () => {
  child?.kill('SIGKILL');
  await upstream.close();
  await redis.quit();
  await pool.end();
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

describe('gateway crash → expiry + sweeper', () => {
  it(
    'a SIGKILLed instance leaves a reservation that is later charged in full and ledgered',
    { timeout: 60_000 },
    async () => {
      const port = await freePort();
      child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        env: {
          ...process.env,
          ...baseTestEnv,
          LOG_LEVEL: 'warn',
          HOST: '127.0.0.1',
          PORT: String(port),
          FAKE_PROVIDER_BASE_URL: upstream.url,
          PRIMARY_MODEL: 'fake:ok?words=1000&gap=20', // ~20 s stream
          FALLBACK_MODELS: '',
          MAX_STREAM_DURATION_MS: String(MAX_STREAM_MS),
          RESERVATION_TTL_MS: String(TTL_MS),
          SWEEPER_INTERVAL_MS: '600000', // the doomed instance never gets to sweep
        },
        stdio: 'ignore',
      });
      const url = `http://127.0.0.1:${port}`;
      await waitUntilReady(url, 20_000);

      const attemptId = uniqueAttemptId();
      const token = await testToken({ attemptId, tokenBudget: 10_000, maxTokensCap: 500 });
      const requestId = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `${url}/v1/chat/completions`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          },
          (res) => {
            res.once('data', () => {
              resolve(String(res.headers['x-request-id']));
            });
          },
        );
        req.on('error', () => undefined); // the server dies under us; that's the point
        req.on('timeout', reject);
        req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
      });

      // Mid-stream, the reservation is held.
      const raw = await redis.hget(redisKeys.reservations(attemptId), requestId);
      expect(raw).not.toBeNull();
      const reserved = (JSON.parse(raw ?? '{}') as { r: number }).r;
      expect(Number(await redis.get(redisKeys.budget(attemptId)))).toBe(10_000 - reserved);

      // Crash: no shutdown hook, no reconcile, no ledger write.
      child.kill('SIGKILL');
      await new Promise((r) => child?.once('exit', r));

      // A surviving instance's sweeper (constructed exactly as gateway.ts does).
      const recorder = new UsageRecorder(new PgUsageLedger(pool), () => undefined);
      const store = new RedisBudgetStore(
        redis,
        { minUsefulTokens: 16, reservationTtlMs: TTL_MS, attemptTtlSec: 3_600 },
        () => Date.now(),
      );
      const sweeper = new ReservationSweeper(
        store,
        recorder,
        { intervalMs: 1, batchSize: 500 },
        { onError: () => undefined },
      );

      const started = Date.now();
      while ((await redis.hlen(redisKeys.reservations(attemptId))) > 0) {
        expect(Date.now() - started).toBeLessThan(TTL_MS + 10_000);
        await sweeper.sweepOnce();
        await new Promise((r) => setTimeout(r, 250));
      }
      await recorder.flush();

      // Not before the TTL: a live stream is never swept early.
      expect(Date.now() - started).toBeGreaterThan(TTL_MS - 3_000);
      // Charged in full (conservative, still ≤ reserved) and recorded.
      expect(Number(await redis.get(redisKeys.budget(attemptId)))).toBe(10_000 - reserved);
      const { rows } = await pool.query('SELECT * FROM usage_ledger WHERE request_id = $1', [
        requestId,
      ]);
      expect(rows[0]).toMatchObject({
        attempt_id: attemptId,
        outcome: 'expired_unreconciled',
        reserved_tokens: reserved,
        charged_tokens: reserved,
      });
    },
  );
});

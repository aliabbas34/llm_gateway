import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsageEntry } from '../../src/domain/types.js';
import { PgHealthCheck } from '../../src/infrastructure/postgres/PgHealthCheck.js';
import { PgUsageLedger } from '../../src/infrastructure/postgres/PgUsageLedger.js';
import { testPgPool, uniqueAttemptId } from '../helpers/infra.js';

let pool: pg.Pool;
let ledger: PgUsageLedger;
beforeAll(() => {
  pool = testPgPool();
  ledger = new PgUsageLedger(pool);
});
afterAll(async () => {
  await pool.end();
});

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    requestId: randomUUID(),
    attemptId: uniqueAttemptId(),
    studentId: 'stu-1',
    model: 'llama-3.3-70b-versatile',
    provider: 'groq',
    inputTokens: 120,
    outputTokens: 80,
    reservedTokens: 632,
    chargedTokens: 200,
    outcome: 'completed',
    latencyMs: 812.4,
    ttftMs: 95.6,
    failoverCount: 0,
    ...overrides,
  };
}

async function rowsFor(requestId: string) {
  const res = await pool.query('SELECT * FROM usage_ledger WHERE request_id = $1', [requestId]);
  return res.rows as Record<string, unknown>[];
}

describe('PgUsageLedger (FR8)', () => {
  it('records one row with every field', async () => {
    const e = entry();
    await ledger.record([e]);
    const [row] = await rowsFor(e.requestId);
    expect(row).toMatchObject({
      request_id: e.requestId,
      attempt_id: e.attemptId,
      student_id: 'stu-1',
      model: 'llama-3.3-70b-versatile',
      provider: 'groq',
      input_tokens: 120,
      output_tokens: 80,
      reserved_tokens: 632,
      charged_tokens: 200,
      outcome: 'completed',
      latency_ms: 812,
      ttft_ms: 96,
      failover_count: 0,
    });
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  it('is idempotent per request_id: a second write is a no-op', async () => {
    const e = entry();
    await ledger.record([e]);
    await ledger.record([{ ...e, chargedTokens: 1, outcome: 'stream_error' }]);
    const rows = await rowsFor(e.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ charged_tokens: 200, outcome: 'completed' });
  });

  it('stores rows without a provider (rejected before any model call)', async () => {
    const e = entry({
      model: null,
      provider: null,
      outcome: 'budget_exhausted',
      ttftMs: null,
      reservedTokens: 0,
      chargedTokens: 0,
      outputTokens: 0,
    });
    await ledger.record([e]);
    expect(await rowsFor(e.requestId)).toHaveLength(1);
  });

  it('enforces the hard-limit invariant charged <= reserved at the storage layer', async () => {
    await expect(ledger.record([entry({ reservedTokens: 10, chargedTokens: 11 })])).rejects.toThrow(
      /usage_ledger_charged_le_reserved/,
    );
  });

  it('rejects an unknown outcome', async () => {
    const bogus = entry({ outcome: 'teleported' as UsageEntry['outcome'] });
    await expect(ledger.record([bogus])).rejects.toThrow(/usage_outcome/);
  });

  it('health check reflects reachability', async () => {
    await expect(new PgHealthCheck(pool).check()).resolves.toBeUndefined();
    const dead = testPgPool({ DATABASE_URL: 'postgres://x:y@127.0.0.1:1/none' });
    await expect(new PgHealthCheck(dead).check()).rejects.toThrow();
    await dead.end();
  });
});

describe('PgUsageLedger batching', () => {
  it('writes a 1 000-row burst in multi-row INSERTs with a tiny pool (the sweeper case)', async () => {
    const small = testPgPool({ PG_POOL_MAX: '2' });
    try {
      const batchLedger = new PgUsageLedger(small);
      const attemptId = uniqueAttemptId();
      const rows = Array.from({ length: 1_000 }, () => entry({ attemptId }));
      await batchLedger.record(rows);
      await batchLedger.record(rows.slice(0, 10)); // duplicates: ignored
      const res = await pool.query('SELECT COUNT(*) AS n FROM usage_ledger WHERE attempt_id = $1', [
        attemptId,
      ]);
      expect(Number((res.rows[0] as { n: string }).n)).toBe(1_000);
    } finally {
      await small.end();
    }
  });
});

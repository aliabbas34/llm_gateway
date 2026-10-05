import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageRecorder } from '../../../src/application/UsageRecorder.js';
import type { UsageEntry } from '../../../src/domain/types.js';
import { InMemoryUsageLedger } from '../../helpers/fakes.js';

afterEach(() => {
  vi.useRealTimers();
});

const entry = (i: number): UsageEntry => ({
  requestId: `r${i}`,
  attemptId: 'a',
  studentId: 's',
  model: null,
  provider: null,
  inputTokens: 1,
  outputTokens: 0,
  reservedTokens: 0,
  chargedTokens: 0,
  outcome: 'budget_exhausted',
  latencyMs: 1,
  ttftMs: null,
  failoverCount: 0,
});

describe('UsageRecorder (async, batched ledger writes)', () => {
  it('buffers rows and writes them in one batch after the flush interval', async () => {
    vi.useFakeTimers();
    const ledger = new InMemoryUsageLedger();
    const r = new UsageRecorder(ledger, () => undefined, { maxBatch: 100, flushIntervalMs: 50 });
    for (let i = 0; i < 5; i++) r.record(entry(i));
    expect(ledger.batches).toEqual([]);
    expect(r.pendingCount).toBe(5);
    await vi.advanceTimersByTimeAsync(50);
    expect(ledger.batches).toEqual([5]);
    expect(ledger.rows.size).toBe(5);
  });

  it('writes immediately when a batch is full, splitting large bursts', async () => {
    const ledger = new InMemoryUsageLedger();
    const r = new UsageRecorder(ledger, () => undefined, {
      maxBatch: 100,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < 250; i++) r.record(entry(i));
    await r.flush();
    expect(ledger.batches).toEqual([100, 100, 50]);
    expect(ledger.rows.size).toBe(250);
    expect(r.pendingCount).toBe(0);
  });

  it('reports a failed batch once per row, and keeps going', async () => {
    const ledger = new InMemoryUsageLedger();
    const failures: string[] = [];
    const r = new UsageRecorder(ledger, (_e, row) => failures.push(row.requestId), { maxBatch: 2 });
    ledger.failWith = new Error('postgres down');
    r.record(entry(1));
    r.record(entry(2));
    await r.flush();
    expect(failures).toEqual(['r1', 'r2']);
    ledger.failWith = undefined;
    r.record(entry(3));
    await r.flush();
    expect([...ledger.rows.keys()]).toEqual(['r3']);
  });

  it('flush() with nothing buffered resolves immediately', async () => {
    await expect(
      new UsageRecorder(new InMemoryUsageLedger(), () => undefined).flush(),
    ).resolves.toBeUndefined();
  });
});

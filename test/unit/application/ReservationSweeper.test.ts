import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReservationSweeper } from '../../../src/application/ReservationSweeper.js';
import { UsageRecorder } from '../../../src/application/UsageRecorder.js';
import { InMemoryBudgetStore, InMemoryUsageLedger } from '../../helpers/fakes.js';

afterEach(() => {
  vi.useRealTimers();
});

async function seed(budget: InMemoryBudgetStore, id: string) {
  await budget.reserve({
    attemptId: 'att',
    reservationId: id,
    studentId: 'stu',
    initialBudget: 1_000,
    maxTokensCap: 100,
    inputTokens: 20,
  });
}

describe('ReservationSweeper (crash recovery)', () => {
  it('claims expired reservations, charges them in full, and writes expired_unreconciled rows', async () => {
    const budget = new InMemoryBudgetStore();
    const ledger = new InMemoryUsageLedger();
    const recorder = new UsageRecorder(ledger, () => undefined);
    await seed(budget, 'dead-1');
    await seed(budget, 'alive-1');
    budget.expire('dead-1');

    const sweeper = new ReservationSweeper(
      budget,
      recorder,
      { intervalMs: 1_000, batchSize: 10 },
      { onError: () => undefined },
    );
    const claimed = await sweeper.sweepOnce();
    await recorder.flush();

    expect(claimed.map((c) => c.reservationId)).toEqual(['dead-1']);
    expect(ledger.rows.get('dead-1')).toEqual({
      requestId: 'dead-1',
      attemptId: 'att',
      studentId: 'stu',
      model: null,
      provider: null,
      inputTokens: 20,
      outputTokens: 0,
      reservedTokens: 120,
      chargedTokens: 120,
      outcome: 'expired_unreconciled',
      latencyMs: 1,
      ttftMs: null,
      failoverCount: 0,
    });
    // Full charge: the budget does not get dead-1's reservation back.
    expect(budget.budgets.get('att')).toBe(1_000 - 120 - 120);
    expect(budget.reservations.has('alive-1')).toBe(true);
    // A late reconcile from the "dead" instance is a no-op.
    expect(await budget.reconcile('att', 'dead-1', 1)).toEqual({ status: 'already_settled' });
  });

  it('runs on an interval, reports errors and keeps going, and stops cleanly', async () => {
    vi.useFakeTimers();
    const budget = new InMemoryBudgetStore();
    const recorder = new UsageRecorder(new InMemoryUsageLedger(), () => undefined);
    const errors: unknown[] = [];
    const sweeper = new ReservationSweeper(
      budget,
      recorder,
      { intervalMs: 100, batchSize: 10 },
      { onError: (e) => errors.push(e) },
    );
    const spy = vi.spyOn(budget, 'sweepExpired');
    spy.mockRejectedValueOnce(new Error('redis down'));

    sweeper.start();
    sweeper.start(); // idempotent
    await vi.advanceTimersByTimeAsync(350);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(1);

    await sweeper.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

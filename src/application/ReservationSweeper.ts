import type { BudgetStore, ExpiredReservation } from '../domain/ports.js';
import type { UsageEntry } from '../domain/types.js';
import type { UsageRecorder } from './UsageRecorder.js';

export interface SweeperHooks {
  readonly onError: (error: unknown) => void;
  readonly onClaimed?: (claimed: readonly ExpiredReservation[]) => void;
}

export interface SweeperOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
}

/**
 * Crash recovery (ADR-0005): periodically claims reservations whose owner never settled them,
 * charges each in full, and writes its `expired_unreconciled` ledger row.
 *
 * Runs on every instance. Claims are atomic in Redis, so concurrent sweepers never double-claim.
 * A tick never overlaps the previous one; errors (e.g. Redis down) are reported and the loop
 * keeps going, since sweeping is retry-safe by construction.
 */
export class ReservationSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;

  constructor(
    private readonly budget: BudgetStore,
    private readonly usage: UsageRecorder,
    private readonly options: SweeperOptions,
    private readonly hooks: SweeperHooks,
  ) {}

  /** One pass. Returns the reservations claimed. Public for tests and manual runs. */
  async sweepOnce(): Promise<ExpiredReservation[]> {
    const claimed = await this.budget.sweepExpired(this.options.batchSize);
    for (const r of claimed) this.usage.record(expiredEntry(r));
    if (claimed.length > 0) this.hooks.onClaimed?.(claimed);
    return claimed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  /** Stop scheduling and wait for an in-flight pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.sweepOnce()
        .catch(this.hooks.onError)
        .finally(() => {
          this.running = undefined;
          this.schedule();
        });
    }, this.options.intervalMs);
    // The sweeper must never keep the process alive on its own.
    this.timer.unref();
  }
}

function expiredEntry(r: ExpiredReservation): UsageEntry {
  return {
    requestId: r.reservationId,
    attemptId: r.attemptId,
    studentId: r.studentId,
    // Unknown: the instance that knew died. Output is unknown too; the charge is the full reservation.
    model: null,
    provider: null,
    inputTokens: r.inputTokens,
    outputTokens: 0,
    reservedTokens: r.reservedTokens,
    chargedTokens: r.reservedTokens,
    outcome: 'expired_unreconciled',
    latencyMs: r.ageMs,
    ttftMs: null,
    failoverCount: 0,
  };
}

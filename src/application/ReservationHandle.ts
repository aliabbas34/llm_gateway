import type { BudgetStore, SettleResult } from '../domain/ports.js';

/**
 * One reservation's lifecycle. Settles at most once, by reconcile (tokens were used) or release
 * (nothing was used). A second call returns the first call's result without touching Redis.
 *
 * Callers pair it with try/finally: `finally { if (!handle.settled) await handle.release() }`,
 * so no code path, including bugs that throw, leaves a reservation behind. If settling itself
 * fails (Redis down), the reservation expires and the sweeper charges it (ADR-0005).
 */
export class ReservationHandle {
  private settlement: Promise<SettleResult> | undefined;

  constructor(
    private readonly store: BudgetStore,
    readonly attemptId: string,
    readonly reservationId: string,
    readonly reservedTokens: number,
    readonly effectiveMaxTokens: number,
  ) {}

  get settled(): boolean {
    return this.settlement !== undefined;
  }

  reconcile(actualTokens: number): Promise<SettleResult> {
    this.settlement ??= this.store.reconcile(this.attemptId, this.reservationId, actualTokens);
    return this.settlement;
  }

  release(): Promise<SettleResult> {
    this.settlement ??= this.store.release(this.attemptId, this.reservationId);
    return this.settlement;
  }
}

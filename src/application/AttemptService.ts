import type { AttemptStatusStore } from '../domain/ports.js';

/**
 * Attempt lifecycle commands from the product backend (FR7).
 *
 * Closing only blocks *new* reservations: the reserve script checks the status atomically, while
 * streams that already hold a reservation run to completion and reconcile normally.
 */
export class AttemptService {
  constructor(private readonly statuses: AttemptStatusStore) {}

  /** Idempotent. */
  async close(attemptId: string): Promise<void> {
    await this.statuses.close(attemptId);
  }
}

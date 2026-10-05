import type { HealthCheck } from '../domain/ports.js';
import type { Lifecycle } from './Lifecycle.js';

export type CheckStatus = 'up' | 'down';

export interface Readiness {
  readonly ready: boolean;
  readonly draining: boolean;
  readonly checks: Readonly<Record<string, CheckStatus>>;
}

/**
 * Decides readiness: not draining AND every dependency check passes within its timeout.
 * Checks run in parallel so one slow dependency does not hide another's status.
 */
export class HealthService {
  constructor(
    private readonly lifecycle: Lifecycle,
    private readonly checks: readonly HealthCheck[],
    private readonly timeoutMs: number,
  ) {}

  async readiness(): Promise<Readiness> {
    const results = await Promise.all(
      this.checks.map(async (c) => [c.name, await this.run(c)] as const),
    );
    const checks = Object.fromEntries(results);
    const draining = this.lifecycle.isDraining();
    const ready = !draining && results.every(([, status]) => status === 'up');
    return { ready, draining, checks };
  }

  private async run(check: HealthCheck): Promise<CheckStatus> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      await Promise.race([
        check.check(signal),
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('timeout'));
          });
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}

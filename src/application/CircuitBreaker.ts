import type { Clock } from '../domain/ports.js';
import { formatModelRef, type ModelRef } from '../domain/types.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive provider failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long an open circuit skips the model before one probe request may try it again. */
  readonly openMs: number;
}

/** Permission to call a model once. The caller reports how the call went. */
export interface CircuitPermit {
  /** The model finished its answer. */
  succeed(): void;
  /** The model failed in a way that says it is unhealthy, before or during its answer. */
  fail(): void;
  /** The call says nothing about the model's health (client left, bad request). */
  abandon(): void;
}

/**
 * Remembers that a model is down, so requests stop waiting for it (ADR-0020).
 *
 *   closed ── N consecutive failures ──▶ open ── openMs elapsed ──▶ half_open
 *     ▲                                   ▲                            │
 *     └────────── probe succeeds ─────────┼──────── probe fails ───────┘
 *
 * While half-open exactly one request probes the model; the others keep skipping it. Only a
 * finished answer counts as success, so a provider that keeps dying mid-answer still trips.
 * State is per instance and in memory: a health hint, never needed for correctness.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probing = false;
  /** Bumped on every opening, so calls started before it can't change the newer state. */
  private generation = 0;

  constructor(
    private readonly clock: Clock,
    private readonly options: CircuitBreakerOptions,
    private readonly onStateChange: (state: CircuitState) => void = () => undefined,
  ) {}

  /** A permit to call the model, or undefined if the model must be skipped for now. */
  tryAcquire(): CircuitPermit | undefined {
    if (this.state === 'open' && this.retryAfterMs() === 0) this.transition('half_open');
    if (this.state === 'open') return undefined;
    if (this.state === 'half_open') {
      if (this.probing) return undefined;
      this.probing = true;
      return this.permit(true);
    }
    return this.permit(false);
  }

  /** Time until a skipped model may be probed again (0 when it may be tried now). */
  retryAfterMs(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.openedAt + this.options.openMs - this.clock.monotonicMs());
  }

  private permit(isProbe: boolean): CircuitPermit {
    const generation = this.generation;
    let settled = false;
    /** Runs `record` once, and only if the circuit has not reopened since this call started. */
    const settle = (record: () => void) => {
      if (settled) return;
      settled = true;
      if (generation !== this.generation) return;
      if (isProbe) this.probing = false;
      record();
    };
    return {
      succeed: () => {
        settle(() => {
          this.recordSuccess();
        });
      },
      fail: () => {
        settle(() => {
          this.recordFailure();
        });
      },
      abandon: () => {
        settle(() => undefined);
      },
    };
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half_open') this.transition('closed');
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    const tripped =
      this.state === 'half_open' ||
      (this.state === 'closed' && this.consecutiveFailures >= this.options.failureThreshold);
    if (!tripped) return;
    this.generation += 1;
    this.probing = false;
    this.openedAt = this.clock.monotonicMs();
    this.transition('open');
  }

  private transition(state: CircuitState): void {
    this.state = state;
    this.onStateChange(state);
  }
}

/** One breaker per configured model, created on first use. */
export class CircuitBreakers {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly clock: Clock,
    private readonly options: CircuitBreakerOptions,
    private readonly onStateChange: (ref: ModelRef, state: CircuitState) => void = () => undefined,
  ) {}

  for(ref: ModelRef): CircuitBreaker {
    const key = formatModelRef(ref);
    let breaker = this.breakers.get(key);
    if (breaker === undefined) {
      breaker = new CircuitBreaker(this.clock, this.options, (state) => {
        this.onStateChange(ref, state);
      });
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}

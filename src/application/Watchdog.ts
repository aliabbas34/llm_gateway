import { ProviderError } from '../domain/providerErrors.js';

export interface StreamTimeouts {
  /** Request sent → first chunk (covers connect, TLS, queueing and time to first token). */
  readonly ttftMs: number;
  /** Silence allowed between two chunks once the stream has started. */
  readonly idleMs: number;
}

/**
 * Aborts one provider attempt when the provider goes quiet for too long. The abort reason is a
 * `ProviderError('timeout')`, which adapters re-throw as-is, so a timeout is classified like any
 * other retryable provider failure (FR6) without special cases in the adapters.
 *
 * The caller pauses the watchdog while it is busy writing to the client: a slow *client* must not
 * be mistaken for a silent *provider*.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly controller: AbortController,
    private readonly provider: string,
    private readonly timeouts: StreamTimeouts,
  ) {}

  armFirstChunk(): void {
    this.arm(this.timeouts.ttftMs, 'no first chunk within the TTFT timeout');
  }

  armIdle(): void {
    this.arm(this.timeouts.idleMs, 'no chunk within the idle timeout');
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number, message: string): void {
    this.pause();
    this.timer = setTimeout(() => {
      this.controller.abort(new ProviderError('timeout', this.provider, message));
    }, ms);
    this.timer.unref();
  }
}

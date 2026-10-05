import type { UsageLedger } from '../domain/ports.js';
import type { UsageEntry } from '../domain/types.js';

export interface UsageRecorderOptions {
  /** Flush as soon as this many rows are queued. */
  readonly maxBatch: number;
  /** Otherwise flush this long after the first queued row. */
  readonly flushIntervalMs: number;
}

const DEFAULTS: UsageRecorderOptions = { maxBatch: 200, flushIntervalMs: 50 };

/**
 * Writes ledger rows off the request path, in small batches (ADR-0010).
 *
 * - Fire-and-forget: a slow or down Postgres never delays or fails a stream (spec: "Postgres down
 *   → stream still served").
 * - Batching: rows are buffered for at most `flushIntervalMs` (or until `maxBatch` are waiting)
 *   and written with one multi-row INSERT. Found by running the demo: the sweeper claimed ~400
 *   stranded reservations at once, and one INSERT per row exhausted the pg pool's acquire
 *   timeout, so the rows were lost.
 * - Failures go to `onFailure`, once per affected row (the composition root logs + counts them).
 * - `flush()` writes everything still buffered and waits for in-flight writes (graceful shutdown).
 */
export class UsageRecorder {
  private queue: UsageEntry[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly options: UsageRecorderOptions;

  constructor(
    private readonly ledger: UsageLedger,
    private readonly onFailure: (error: unknown, entry: UsageEntry) => void,
    options: Partial<UsageRecorderOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  record(entry: UsageEntry): void {
    this.queue.push(entry);
    if (this.queue.length >= this.options.maxBatch) {
      this.writeQueued();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.writeQueued();
      }, this.options.flushIntervalMs);
      this.timer.unref();
    }
  }

  /** Write everything buffered now, and resolve when every write so far has finished. */
  async flush(): Promise<void> {
    this.writeQueued();
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  get pendingCount(): number {
    return this.queue.length + this.pending.size;
  }

  private writeQueued(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.options.maxBatch);
      const write: Promise<void> = this.ledger
        .record(batch)
        .catch((error: unknown) => {
          for (const entry of batch) this.onFailure(error, entry);
        })
        .finally(() => this.pending.delete(write));
      this.pending.add(write);
    }
  }
}

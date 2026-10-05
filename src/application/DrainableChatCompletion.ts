import { ShutdownAbort } from '../domain/abort.js';
import { ShuttingDownError } from '../domain/errors.js';
import type { ChatCompletion, ChatInput, ChatResult } from './ChatCompletionService.js';
import type { ChatSink } from './ChatSink.js';
import type { Lifecycle } from './Lifecycle.js';

/**
 * Graceful-shutdown support around the chat use case (decorator):
 * - refuses new work once the instance is draining (503 + Retry-After);
 * - tracks every in-flight completion, so shutdown can wait for them;
 * - owns ONE shutdown signal shared by all in-flight requests: `abortAll()` stops the stragglers
 *   at the drain deadline. Each of them still settles its reservation on the way out.
 */
export class DrainableChatCompletion implements ChatCompletion {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly inner: ChatCompletion,
    private readonly lifecycle: Lifecycle,
  ) {}

  async complete(input: ChatInput, sink: ChatSink, clientSignal: AbortSignal): Promise<ChatResult> {
    if (this.lifecycle.isDraining()) throw new ShuttingDownError();
    const signal = AbortSignal.any([clientSignal, this.shutdown.signal]);
    const work = this.inner.complete(input, sink, signal);
    this.inFlight.add(work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  /** Resolve true when every in-flight completion has finished, false at the timeout. */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    const finished = this.settled().then(() => true as const);
    try {
      return await Promise.race([finished, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Abort every in-flight completion (they settle their reservations as shutdown_aborted). */
  abortAll(): void {
    this.shutdown.abort(new ShutdownAbort());
  }

  /** Resolves once the in-flight set is empty (including requests that start meanwhile). */
  private async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

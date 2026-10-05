import { ShutdownAbort } from '../domain/abort.js';
import { ProviderError } from '../domain/providerErrors.js';
import type { Clock, ResolvedModel } from '../domain/ports.js';
import type { ChatChunk, ProviderRequest, Usage } from '../domain/types.js';
import type { ChatSink } from './ChatSink.js';
import { Watchdog, type StreamTimeouts } from './Watchdog.js';

/** How streaming from one model ended, once the response was committed or the client left. */
export interface ModelRun {
  readonly model: ResolvedModel;
  readonly outcome: 'completed' | 'stream_error' | 'client_disconnected' | 'shutdown_aborted';
  /** Set when outcome is stream_error. */
  readonly error: ProviderError | undefined;
  readonly streamedText: string;
  readonly providerUsage: Usage | undefined;
  readonly ttftMs: number | null;
  /** This model's own latency: its request sent → its first chunk (null if none arrived). */
  readonly upstreamTtftMs: number | null;
}

/**
 * Streams ONE model into the sink and owns the commit decision (FR6):
 * - the response is committed (`sink.open`) on the first real output (delta or finish);
 * - a provider failure BEFORE commit is thrown as ProviderError, so the caller may fail over;
 * - a failure AFTER commit is returned as `stream_error`; the caller reports it in-stream;
 * - our own aborts are outcomes, not failures: `client_disconnected` or `shutdown_aborted`.
 *
 * Only `iterator.next()` failures count as provider failures. A sink failure is our own bug and
 * propagates; the finally still closes the iterator, which cancels the upstream request.
 */
export class ModelStreamer {
  constructor(
    private readonly clock: Clock,
    private readonly timeouts: StreamTimeouts,
  ) {}

  async run(
    model: ResolvedModel,
    request: ProviderRequest,
    sink: ChatSink,
    requestSignal: AbortSignal,
    startedAt: number,
  ): Promise<ModelRun> {
    // One controller per attempt: a timeout aborts this attempt only, not the whole request.
    const attempt = new AbortController();
    const watchdog = new Watchdog(attempt, model.provider.name, this.timeouts);
    const signal = AbortSignal.any([requestSignal, attempt.signal]);

    let streamedText = '';
    let providerUsage: Usage | undefined;
    let ttftMs: number | null = null;
    let upstreamTtftMs: number | null = null;
    const attemptStartedAt = this.clock.monotonicMs();
    const runResult = (outcome: ModelRun['outcome'], error?: ProviderError): ModelRun => ({
      model,
      outcome,
      error,
      streamedText,
      providerUsage,
      ttftMs,
      upstreamTtftMs,
    });
    const commit = () => {
      if (sink.opened) return;
      sink.open({ model: model.ref.model });
      ttftMs = this.clock.monotonicMs() - startedAt;
    };

    watchdog.armFirstChunk();
    const iterator = model.provider.streamChat(request, signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<ChatChunk>;
        try {
          next = await iterator.next();
        } catch (err) {
          const error = toProviderError(err, model.provider.name);
          if (error.kind === 'aborted' && requestSignal.aborted) {
            // Ours, not the provider's: why was the request aborted?
            if (requestSignal.reason instanceof ShutdownAbort) return runResult('shutdown_aborted');
            if (isClientAbort(requestSignal)) return runResult('client_disconnected');
          }
          if (!sink.opened) throw error;
          return runResult('stream_error', error);
        }
        if (next.done === true) return runResult('completed');

        watchdog.pause(); // writing to a slow client is not provider silence
        upstreamTtftMs ??= this.clock.monotonicMs() - attemptStartedAt;
        const chunk = next.value;
        switch (chunk.type) {
          case 'delta':
            commit();
            streamedText += chunk.content;
            await sink.delta(chunk.content);
            break;
          case 'finish':
            commit();
            await sink.finish(chunk.reason);
            break;
          case 'usage':
            providerUsage = chunk.usage;
            break;
        }
        watchdog.armIdle();
      }
    } finally {
      watchdog.pause();
      await iterator.return?.().catch(() => undefined);
    }
  }
}

/** Aborted by the client, as opposed to by one of our timeouts or by shutdown. */
function isClientAbort(requestSignal: AbortSignal): boolean {
  const reason: unknown = requestSignal.reason;
  return (
    requestSignal.aborted &&
    !(reason instanceof ProviderError) &&
    !(reason instanceof ShutdownAbort)
  );
}

/** Adapters must throw ProviderError; anything else is an adapter bug, treated as protocol_error. */
function toProviderError(err: unknown, provider: string): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError('protocol_error', provider, 'adapter threw a non-ProviderError', {
        cause: err,
      });
}

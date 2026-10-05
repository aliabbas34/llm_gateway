import { ProviderError, type ProviderErrorKind } from '../../domain/providerErrors.js';
import type { LlmProvider } from '../../domain/ports.js';
import type { ChatChunk, ProviderRequest, Usage } from '../../domain/types.js';

/** What a FakeProvider call does. Every field is optional; the default is a short success. */
export interface FakeScript {
  readonly deltas?: readonly string[];
  /** `null` = the provider reports no usage (forces the gateway to count tokens itself). */
  readonly usage?: Usage | null;
  readonly finishReason?: string;
  readonly firstChunkDelayMs?: number;
  readonly chunkDelayMs?: number;
  /** Fail before yielding anything (failover-eligible if retryable). */
  readonly failBeforeFirstChunk?: ProviderErrorKind;
  /** Attached to the failBeforeFirstChunk error (models an upstream Retry-After header). */
  readonly retryAfterSec?: number;
  /** Yield this many deltas, then fail (after first byte: no failover). */
  readonly failAfterDeltas?: { readonly count: number; readonly kind: ProviderErrorKind };
  /** Yield this many deltas, then stall until aborted (exercises idle timeouts / disconnects). */
  readonly hangAfterDeltas?: number;
}

/**
 * In-process scripted provider for unit, service and contract tests. Implements the full
 * LlmProvider contract, including abort and error classification, without any network.
 */
export class FakeProvider implements LlmProvider {
  readonly calls: ProviderRequest[] = [];
  private readonly script: (request: ProviderRequest, call: number) => FakeScript;

  constructor(
    readonly name: string,
    script: FakeScript | ((request: ProviderRequest, call: number) => FakeScript) = {},
  ) {
    this.script = typeof script === 'function' ? script : () => script;
  }

  async *streamChat(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    this.calls.push(request);
    const s = this.script(request, this.calls.length);
    const deltas = s.deltas ?? ['Hello', ' from', ' fake'];

    this.throwIfAborted(signal);
    await this.sleep(s.firstChunkDelayMs ?? 0, signal);
    if (s.failBeforeFirstChunk) {
      throw new ProviderError(
        s.failBeforeFirstChunk,
        this.name,
        'scripted failure before first chunk',
        s.retryAfterSec === undefined ? {} : { retryAfterSec: s.retryAfterSec },
      );
    }

    for (const [i, content] of deltas.entries()) {
      if (s.failAfterDeltas?.count === i) {
        throw new ProviderError(s.failAfterDeltas.kind, this.name, 'scripted mid-stream failure');
      }
      if (s.hangAfterDeltas === i) await this.sleep(Number.POSITIVE_INFINITY, signal);
      if (i > 0) await this.sleep(s.chunkDelayMs ?? 0, signal);
      yield { type: 'delta', content };
    }
    if (s.failAfterDeltas && s.failAfterDeltas.count >= deltas.length) {
      throw new ProviderError(s.failAfterDeltas.kind, this.name, 'scripted mid-stream failure');
    }
    if (s.hangAfterDeltas !== undefined && s.hangAfterDeltas >= deltas.length) {
      await this.sleep(Number.POSITIVE_INFINITY, signal);
    }

    yield { type: 'finish', reason: s.finishReason ?? 'stop' };
    const usage =
      s.usage === undefined ? { inputTokens: 10, outputTokens: deltas.length } : s.usage;
    if (usage !== null) yield { type: 'usage', usage };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason: unknown = signal.reason;
    throw reason instanceof ProviderError
      ? reason
      : new ProviderError('aborted', this.name, 'request aborted');
  }

  /** Abortable sleep. `ms = Infinity` sleeps until aborted. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        try {
          this.throwIfAborted(signal);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const timer = Number.isFinite(ms)
        ? setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms)
        : undefined;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

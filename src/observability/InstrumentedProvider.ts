import { ProviderError } from '../domain/providerErrors.js';
import type { LlmProvider } from '../domain/ports.js';
import type { ChatChunk, ProviderRequest } from '../domain/types.js';
import type { Metrics } from './metrics.js';

/**
 * Decorator: adds per-provider metrics to any LlmProvider without touching adapters or services
 * (OCP). Same contract as the wrapped provider; chunks and errors pass through unchanged.
 */
export class InstrumentedProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly metrics: Pick<Metrics, 'providerRequests' | 'providerFirstChunk'>,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.name = inner.name;
  }

  async *streamChat(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    const started = this.now();
    let first = true;
    let result = 'ok';
    try {
      for await (const chunk of this.inner.streamChat(request, signal)) {
        if (first) {
          first = false;
          this.metrics.providerFirstChunk.observe(
            { provider: this.name },
            (this.now() - started) / 1000,
          );
        }
        yield chunk;
      }
    } catch (err) {
      result = err instanceof ProviderError ? err.kind : 'unclassified';
      throw err;
    } finally {
      // Also reached when the consumer stops early (client gone, commit-time abort): counted as ok
      // unless the provider itself threw.
      this.metrics.providerRequests.inc({ provider: this.name, result });
    }
  }
}

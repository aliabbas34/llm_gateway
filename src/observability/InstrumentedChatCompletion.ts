import type {
  ChatCompletion,
  ChatInput,
  ChatResult,
} from '../application/ChatCompletionService.js';
import type { ChatSink } from '../application/ChatSink.js';
import { GatewayError } from '../domain/errors.js';
import type { Metrics } from './metrics.js';

/**
 * Decorator: chat-level metrics around the service (outcomes, in-flight streams, TTFT, tokens,
 * failovers). Keeps prom-client out of the application layer (DIP) and the route free of
 * bookkeeping (SRP).
 */
export class InstrumentedChatCompletion implements ChatCompletion {
  constructor(
    private readonly inner: ChatCompletion,
    private readonly metrics: Metrics,
  ) {}

  async complete(input: ChatInput, sink: ChatSink, signal: AbortSignal): Promise<ChatResult> {
    const m = this.metrics;
    m.activeStreams.inc();
    try {
      const result = await this.inner.complete(input, sink, signal);
      m.chatOutcomes.inc({ outcome: result.outcome });
      if (result.ttftMs !== null && result.model) {
        m.timeToFirstToken.observe({ provider: result.model.provider }, result.ttftMs / 1000);
      }
      if (result.addedLatencyMs !== null) m.addedLatency.observe(result.addedLatencyMs / 1000);
      if (result.chargedTokens !== null) m.tokensCharged.inc(result.chargedTokens);
      for (const reason of result.failoverReasons) m.failovers.inc({ reason });
      return result;
    } catch (err) {
      // Rejections before streaming: budget_exhausted, attempt_closed, upstream_unavailable, …
      m.chatOutcomes.inc({ outcome: err instanceof GatewayError ? err.code : 'internal_error' });
      throw err;
    } finally {
      m.activeStreams.dec();
    }
  }
}

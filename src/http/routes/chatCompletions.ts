import type { ChatCompletion } from '../../application/ChatCompletionService.js';
import type { RateLimiter, TokenVerifier } from '../../domain/ports.js';
import { registerAttemptAuth, requireClaims } from '../plugins/auth.js';
import { registerAttemptRateLimit, registerIpRateLimit } from '../plugins/rateLimit.js';
import { chatRequestSchema } from '../schemas/chat.js';
import { SseWriter } from '../sse/SseWriter.js';
import type { GatewayApp } from '../types.js';

export interface ChatRouteDeps {
  readonly chat: ChatCompletion;
  readonly verifier: TokenVerifier;
  readonly ipLimiter: RateLimiter;
  readonly attemptLimiter: RateLimiter;
  readonly writeTimeoutMs: number;
}

/**
 * FR1 `POST /v1/chat/completions`. The handler only parses, delegates to the service and wires
 * the transport (SRP); the pipeline steps before it are hooks on this encapsulated scope.
 */
export function registerChatRoutes(app: GatewayApp, deps: ChatRouteDeps): void {
  void app.register((scope: GatewayApp, _opts, done) => {
    // Pipeline (requestId is step 1, global). Hooks of one type run in registration order.
    registerIpRateLimit(scope, deps.ipLimiter); // 2. onRequest
    registerAttemptAuth(scope, deps.verifier); // 3. onRequest
    // 4. validation: route schema (Fastify validates between preValidation and preHandler)
    registerAttemptRateLimit(scope, deps.attemptLimiter); // 5. preHandler
    // 6. reserve + 7. handler: inside ChatCompletionService (ADR-0004)
    scope.post(
      '/v1/chat/completions',
      { schema: { body: chatRequestSchema } },
      async (request, reply) => {
        const claims = requireClaims(request);

        // Client disconnect: 'close' before the response finished means the client went away.
        // Aborting cancels the upstream fetch, so we stop paying for tokens nobody will read.
        const abort = new AbortController();
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) abort.abort();
        });

        const result = await deps.chat.complete(
          {
            requestId: request.id,
            claims,
            messages: request.body.messages,
            pipelineMs: reply.elapsedTime,
          },
          new SseWriter(reply, deps.writeTimeoutMs),
          abort.signal,
        );

        request.log.info(
          {
            outcome: result.outcome,
            model: result.model?.model,
            provider: result.model?.provider,
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            usage_source: result.usageSource,
            ttft_ms: result.ttftMs === null ? null : Math.round(result.ttftMs),
            added_latency_ms:
              result.addedLatencyMs === null ? null : Math.round(result.addedLatencyMs * 10) / 10,
            latency_ms: Math.round(result.latencyMs),
            failover_count: result.failoverCount,
            failover_reasons: result.failoverReasons,
            reserved_tokens: result.reservedTokens,
            charged_tokens: result.chargedTokens,
            remaining_tokens: result.remainingTokens,
            settlement: result.settlement,
          },
          'chat completion finished',
        );
      },
    );

    done();
  });
}

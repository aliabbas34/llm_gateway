import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { AttemptService } from '../application/AttemptService.js';
import type { ChatCompletion } from '../application/ChatCompletionService.js';
import type { HealthService } from '../application/HealthService.js';
import type { Config } from '../config/loadConfig.js';
import { MAX_BODY_BYTES } from '../domain/limits.js';
import type { IdGenerator, RateLimiter, TokenVerifier } from '../domain/ports.js';
import type { Metrics } from '../observability/metrics.js';
import { registerAccessLog } from './plugins/accessLog.js';
import { registerCors } from './plugins/cors.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { registerRequestId } from './plugins/requestId.js';
import { registerAttemptRoutes } from './routes/attempts.js';
import { registerChatRoutes } from './routes/chatCompletions.js';
import { registerHealthRoutes } from './routes/health.js';
import type { GatewayApp } from './types.js';

/** Everything the HTTP layer needs, already constructed. buildApp performs no I/O of its own. */
export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly health: HealthService;
  readonly attempts: AttemptService;
  readonly chat: ChatCompletion;
  readonly verifier: TokenVerifier;
  readonly rateLimiters: { readonly ip: RateLimiter; readonly attempt: RateLimiter };
  readonly metrics: Metrics;
}

export async function buildApp(deps: AppDeps): Promise<GatewayApp> {
  const { config } = deps;
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app: GatewayApp = Fastify({
    loggerInstance,
    // Fastify's per-request logs are replaced by our own access log (metadata only, NFR9).
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),
    requestIdHeader: false,
    genReqId: () => deps.ids.next(),
    bodyLimit: MAX_BODY_BYTES,
    // Trust exactly N proxy hops (ADR-0009); with 0 the socket address is the client IP.
    trustProxy: (_address, hop) => hop < config.http.trustProxyHops,
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorateRequest('attemptClaims', null);

  // Global pipeline step 1 (request id) and cross-cutting concerns.
  registerErrorHandler(app);
  registerRequestId(app);
  registerAccessLog(app, deps.metrics);
  await registerCors(app, config.http.corsAllowedOrigins);

  registerHealthRoutes(app, deps.health);
  registerChatRoutes(app, {
    chat: deps.chat,
    verifier: deps.verifier,
    ipLimiter: deps.rateLimiters.ip,
    attemptLimiter: deps.rateLimiters.attempt,
    writeTimeoutMs: config.streaming.writeTimeoutMs,
  });
  registerAttemptRoutes(app, {
    attempts: deps.attempts,
    serviceApiKey: config.auth.serviceApiKey,
  });

  return app;
}

/**
 * Composition root: the only place that constructs real adapters and wires them together.
 *
 * `server.ts` (the process entry point) calls this with config from the environment; e2e tests
 * call it with test config, so they exercise exactly the wiring that ships. Nothing here reads
 * process.env or installs signal handlers.
 */
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Logger } from 'pino';
import { AttemptService } from './application/AttemptService.js';
import { ChatCompletionService } from './application/ChatCompletionService.js';
import { DrainableChatCompletion } from './application/DrainableChatCompletion.js';
import { HealthService } from './application/HealthService.js';
import { Lifecycle } from './application/Lifecycle.js';
import { ReservationSweeper } from './application/ReservationSweeper.js';
import { UsageRecorder } from './application/UsageRecorder.js';
import type { Config } from './config/loadConfig.js';
import { buildApp } from './http/app.js';
import type { GatewayApp } from './http/types.js';
import { JwtTokenVerifier } from './infrastructure/auth/JwtTokenVerifier.js';
import { PgHealthCheck } from './infrastructure/postgres/PgHealthCheck.js';
import { PgUsageLedger } from './infrastructure/postgres/PgUsageLedger.js';
import { createPgPool } from './infrastructure/postgres/pool.js';
import type { FetchFn } from './infrastructure/providers/OpenAiCompatibleProvider.js';
import { ProviderRegistry } from './infrastructure/providers/ProviderRegistry.js';
import { createRedisClient } from './infrastructure/redis/client.js';
import { redisKeys } from './infrastructure/redis/keys.js';
import { RedisAttemptStatusStore } from './infrastructure/redis/RedisAttemptStatusStore.js';
import { RedisBudgetStore } from './infrastructure/redis/RedisBudgetStore.js';
import { RedisHealthCheck } from './infrastructure/redis/RedisHealthCheck.js';
import { RedisRateLimiter } from './infrastructure/redis/RedisRateLimiter.js';
import { SystemClock } from './infrastructure/system/SystemClock.js';
import { UuidGenerator } from './infrastructure/system/UuidGenerator.js';
import { GptTokenCounter } from './infrastructure/tokenizer/GptTokenCounter.js';
import { InstrumentedChatCompletion } from './observability/InstrumentedChatCompletion.js';
import { InstrumentedProvider } from './observability/InstrumentedProvider.js';
import { createMetrics, type Metrics } from './observability/metrics.js';
import { safeError } from './observability/safeError.js';

const READINESS_CHECK_TIMEOUT_MS = 1_000;
const RATE_LIMIT_PERIOD_MS = 60_000;
/** After the drain deadline, how long aborted streams get to settle their reservations. */
const ABORT_SETTLE_GRACE_MS = 5_000;

export interface Gateway {
  readonly app: GatewayApp;
  readonly lifecycle: Lifecycle;
  readonly redis: Redis;
  readonly pgPool: pg.Pool;
  readonly usage: UsageRecorder;
  readonly sweeper: ReservationSweeper;
  readonly metrics: Metrics;
  /** Stop accepting work, drain, release resources. Idempotent. */
  shutdown(reason: string): Promise<void>;
}

export interface GatewayOptions {
  /** Test seam for provider HTTP calls. */
  readonly fetch?: FetchFn;
  /** Start the crash-recovery sweeper (default true). Tests that own sweeping turn it off. */
  readonly startSweeper?: boolean;
  /** Process-level default metrics (CPU, memory, event loop). Off when several gateways share a process. */
  readonly defaultMetrics?: boolean;
}

export async function createGateway(
  config: Config,
  logger: Logger,
  options: GatewayOptions = {},
): Promise<Gateway> {
  const metrics = createMetrics({ defaultMetrics: options.defaultMetrics ?? true });
  // A dedicated connection pool for provider calls, sized for concurrent streams. Measured on
  // Windows: the global fetch dispatcher added ~15 ms per request on loopback; this Agent ~1 ms.
  const upstreamPool = new Agent({ connections: config.upstream.maxConnections });
  const upstreamFetch: FetchFn = (url, init) =>
    undiciFetch(url, { ...init, dispatcher: upstreamPool });
  // Fail fast on bad keys / unknown providers before opening any connection.
  const registry = ProviderRegistry.fromConfig(config, options.fetch ?? upstreamFetch);
  // Decorate every provider with metrics (OCP: adapters and services are unaware).
  const models = registry
    .modelChain()
    .map((m) => ({ ref: m.ref, provider: new InstrumentedProvider(m.provider, metrics) }));
  const verifier = await JwtTokenVerifier.fromPem(config.auth.jwtPublicKeyPem, {
    clockToleranceSec: config.auth.clockToleranceSec,
  });
  const counter = new GptTokenCounter(config.tokens.estimateMultiplier);
  counter.countText('warm-up'); // load BPE ranks now, not on the first request

  const redis = createRedisClient(config, logger);
  const pgPool = createPgPool(config, logger);
  // Don't block startup on Redis: the instance starts, fails closed and reports not-ready until
  // Redis is reachable; ioredis keeps reconnecting in the background.
  redis.connect().catch((err: unknown) => {
    logger.warn(
      { error: safeError(err) },
      'initial redis connection failed; retrying in background',
    );
  });

  const clock = new SystemClock();
  const budget = new RedisBudgetStore(
    redis,
    {
      minUsefulTokens: config.budget.minUsefulTokens,
      reservationTtlMs: config.budget.reservationTtlMs,
      attemptTtlSec: config.attempts.ttlSec,
    },
    () => clock.nowMs(),
  );
  const usage = new UsageRecorder(new PgUsageLedger(pgPool), (err, entry) => {
    // The stream was already served; the row is lost (ADR-0010). Ids only, never content.
    metrics.ledgerWriteFailures.inc();
    logger.error(
      {
        error: safeError(err),
        request_id: entry.requestId,
        attempt_id: entry.attemptId,
        outcome: entry.outcome,
      },
      'usage ledger write failed',
    );
  });

  const sweeper = new ReservationSweeper(budget, usage, config.sweeper, {
    onError: (err) => {
      metrics.sweeperErrors.inc();
      logger.warn({ error: safeError(err) }, 'reservation sweep failed; will retry');
    },
    onClaimed: (claimed) => {
      metrics.sweeperClaims.inc(claimed.length);
      logger.warn(
        { count: claimed.length, request_ids: claimed.map((c) => c.reservationId) },
        'claimed expired reservations (charged in full)',
      );
    },
  });

  const lifecycle = new Lifecycle();
  const health = new HealthService(
    lifecycle,
    [new RedisHealthCheck(redis), new PgHealthCheck(pgPool)],
    READINESS_CHECK_TIMEOUT_MS,
  );

  // Outermost decorator: draining refuses new work and tracks in-flight streams for shutdown.
  const chat = new DrainableChatCompletion(
    new InstrumentedChatCompletion(
      new ChatCompletionService({
        models,
        counter,
        clock,
        systemPrompt: config.systemPrompt,
        budget,
        usage,
        timeouts: {
          ttftMs: config.streaming.ttftTimeoutMs,
          idleMs: config.streaming.idleTimeoutMs,
          maxStreamDurationMs: config.budget.maxStreamDurationMs,
        },
      }),
      metrics,
    ),
    lifecycle,
  );

  const app = await buildApp({
    config,
    logger,
    ids: new UuidGenerator(),
    health,
    attempts: new AttemptService(new RedisAttemptStatusStore(redis, config.attempts.ttlSec)),
    verifier,
    rateLimiters: {
      ip: new RedisRateLimiter(
        redis,
        { limit: config.rateLimits.ipPerMinute, periodMs: RATE_LIMIT_PERIOD_MS },
        redisKeys.ipRate,
      ),
      attempt: new RedisRateLimiter(
        redis,
        { limit: config.rateLimits.attemptPerMinute, periodMs: RATE_LIMIT_PERIOD_MS },
        redisKeys.attemptRate,
      ),
    },
    metrics,
    chat,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      const drainMs = config.shutdown.drainTimeoutMs;
      logger.info({ reason, in_flight: chat.activeCount, drain_ms: drainMs }, 'shutdown started');
      // 1. Not ready: /readyz → 503 so the load balancer stops routing here; new chats → 503.
      lifecycle.startDraining();
      await sweeper.stop();
      // 2. Stop accepting connections. In-flight streams keep running; idle keep-alives close.
      const closed = app.close();
      // 3. Let running streams finish, up to the deadline.
      const drained = await chat.drain(drainMs);
      if (!drained) {
        // 4. Abort the stragglers; each one settles (reconcile/release) and writes its ledger row.
        logger.warn({ in_flight: chat.activeCount }, 'drain deadline reached; aborting streams');
        chat.abortAll();
        await chat.drain(ABORT_SETTLE_GRACE_MS);
      }
      // server.close() only closed connections idle at the time it was called. Connections whose
      // stream ended during the drain are idle keep-alives now: close them, or close() would wait
      // for the clients' own keep-alive timeouts. Anything still open after the grace is cut.
      app.server.closeIdleConnections();
      const forced = setTimeout(() => {
        app.server.closeAllConnections();
      }, ABORT_SETTLE_GRACE_MS);
      await closed;
      clearTimeout(forced);
      // 5. Last ledger writes, then release connections.
      await usage.flush();
      await Promise.allSettled([redis.quit(), pgPool.end(), upstreamPool.close()]);
      logger.info({ drained }, 'shutdown complete');
    })();
    return shutdownPromise;
  };

  if (options.startSweeper ?? true) sweeper.start();

  return { app, lifecycle, redis, pgPool, usage, sweeper, metrics, shutdown };
}

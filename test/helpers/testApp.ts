import { AttemptService } from '../../src/application/AttemptService.js';
import { ChatCompletionService } from '../../src/application/ChatCompletionService.js';
import { UsageRecorder } from '../../src/application/UsageRecorder.js';
import { HealthService } from '../../src/application/HealthService.js';
import { Lifecycle } from '../../src/application/Lifecycle.js';
import type { Config } from '../../src/config/loadConfig.js';
import type { HealthCheck, ResolvedModel } from '../../src/domain/ports.js';
import { buildApp } from '../../src/http/app.js';
import type { GatewayApp } from '../../src/http/types.js';
import { JwtTokenVerifier } from '../../src/infrastructure/auth/JwtTokenVerifier.js';
import { FakeProvider } from '../../src/infrastructure/providers/FakeProvider.js';
import { SystemClock } from '../../src/infrastructure/system/SystemClock.js';
import { GptTokenCounter } from '../../src/infrastructure/tokenizer/GptTokenCounter.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics, type Metrics } from '../../src/observability/metrics.js';
import {
  CountingRateLimiter,
  InMemoryAttemptStatusStore,
  InMemoryBudgetStore,
  InMemoryUsageLedger,
} from './fakes.js';
import { LogCapture } from './logCapture.js';
import { SequentialIds } from './sequentialIds.js';
import { testConfig } from './testConfig.js';
import { TEST_PUBLIC_KEY_PEM } from './testKeys.js';

export interface TestApp {
  readonly app: GatewayApp;
  readonly logs: LogCapture;
  readonly lifecycle: Lifecycle;
  readonly statuses: InMemoryAttemptStatusStore;
  readonly config: Config;
  readonly ipLimiter: CountingRateLimiter;
  readonly attemptLimiter: CountingRateLimiter;
  readonly budget: InMemoryBudgetStore;
  readonly ledger: InMemoryUsageLedger;
  readonly recorder: UsageRecorder;
  readonly metrics: Metrics;
}

export interface TestAppOptions {
  readonly config?: Config;
  readonly checks?: HealthCheck[];
  /** Model chain; defaults to a single in-process FakeProvider. */
  readonly models?: ResolvedModel[];
  readonly ipLimiter?: CountingRateLimiter;
  readonly attemptLimiter?: CountingRateLimiter;
  readonly budget?: InMemoryBudgetStore;
}

export const defaultFakeModels = (): ResolvedModel[] => [
  { ref: { provider: 'fake', model: 'fake-model' }, provider: new FakeProvider('fake') },
];

/** buildApp wired with in-memory fakes (no Redis/Postgres, no network). */
export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const config = opts.config ?? testConfig();
  const logs = new LogCapture();
  const lifecycle = new Lifecycle();
  const statuses = new InMemoryAttemptStatusStore();
  const ipLimiter = opts.ipLimiter ?? new CountingRateLimiter();
  const attemptLimiter = opts.attemptLimiter ?? new CountingRateLimiter();
  const budget = opts.budget ?? new InMemoryBudgetStore();
  const ledger = new InMemoryUsageLedger();
  const recorder = new UsageRecorder(ledger, () => undefined);
  const metrics = createMetrics({ defaultMetrics: false });
  const app = await buildApp({
    config,
    logger: createLogger(config, logs),
    ids: new SequentialIds(),
    health: new HealthService(lifecycle, opts.checks ?? [], 200),
    attempts: new AttemptService(statuses),
    rateLimiters: { ip: ipLimiter, attempt: attemptLimiter },
    metrics,
    verifier: await JwtTokenVerifier.fromPem(TEST_PUBLIC_KEY_PEM, { clockToleranceSec: 0 }),
    chat: new ChatCompletionService({
      models: opts.models ?? defaultFakeModels(),
      counter: new GptTokenCounter(config.tokens.estimateMultiplier),
      clock: new SystemClock(),
      systemPrompt: config.systemPrompt,
      budget,
      usage: recorder,
      timeouts: {
        ttftMs: config.streaming.ttftTimeoutMs,
        idleMs: config.streaming.idleTimeoutMs,
        maxStreamDurationMs: config.budget.maxStreamDurationMs,
      },
    }),
  });
  return {
    app,
    logs,
    lifecycle,
    statuses,
    config,
    ipLimiter,
    attemptLimiter,
    budget,
    ledger,
    recorder,
    metrics,
  };
}

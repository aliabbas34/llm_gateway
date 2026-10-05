import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * All gateway metrics in one injected registry (no prom-client global state, so tests and
 * multiple gateway instances in one process never collide).
 *
 * Label sets are small and bounded: route templates (not URLs), provider names, outcome enums
 * and error kinds. Never attempt ids, students or anything user-controlled (cardinality + privacy).
 */
export function createMetrics(options: { defaultMetrics?: boolean } = {}) {
  const registry = new Registry();
  if (options.defaultMetrics ?? true) {
    // Process CPU/memory and event-loop lag: the lag is the first signal for NFR3 (≤ 50 ms p95).
    collectDefaultMetrics({ register: registry, prefix: 'gateway_' });
  }

  const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

  return {
    registry,

    httpRequests: new Counter({
      name: 'gateway_http_requests_total',
      help: 'HTTP requests by route template and status (499 = client closed the connection).',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'Time from request start to response end (for SSE: the whole stream).',
      labelNames: ['route'] as const,
      buckets: latencyBuckets,
      registers: [registry],
    }),

    chatOutcomes: new Counter({
      name: 'gateway_chat_requests_total',
      help: 'Chat completions by outcome (ledger outcomes plus pre-reserve rejections).',
      labelNames: ['outcome'] as const,
      registers: [registry],
    }),
    activeStreams: new Gauge({
      name: 'gateway_active_streams',
      help: 'Chat completions currently in flight on this instance.',
      registers: [registry],
    }),
    timeToFirstToken: new Histogram({
      name: 'gateway_ttft_seconds',
      help: 'Request start → first token sent to the client (includes gateway overhead and failover).',
      labelNames: ['provider'] as const,
      buckets: latencyBuckets,
      registers: [registry],
    }),
    addedLatency: new Histogram({
      name: 'gateway_added_latency_seconds',
      help: 'NFR3: latency added by the gateway before the first token (provider TTFT excluded).',
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    tokensCharged: new Counter({
      name: 'gateway_tokens_charged_total',
      help: 'Tokens charged against attempt budgets.',
      registers: [registry],
    }),
    failovers: new Counter({
      name: 'gateway_failovers_total',
      help: 'Failed candidates before a served response, by error kind (502s: see provider metrics).',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),

    providerRequests: new Counter({
      name: 'gateway_provider_requests_total',
      help: 'Upstream provider calls by provider and result (ok or ProviderError kind).',
      labelNames: ['provider', 'result'] as const,
      registers: [registry],
    }),
    providerFirstChunk: new Histogram({
      name: 'gateway_provider_first_chunk_seconds',
      help: 'Upstream request sent → first chunk received, per provider.',
      labelNames: ['provider'] as const,
      buckets: latencyBuckets,
      registers: [registry],
    }),

    ledgerWriteFailures: new Counter({
      name: 'gateway_ledger_write_failures_total',
      help: 'Usage-ledger rows that could not be written to Postgres (ADR-0010).',
      registers: [registry],
    }),
    sweeperClaims: new Counter({
      name: 'gateway_sweeper_claimed_reservations_total',
      help: 'Expired reservations claimed and charged in full by the sweeper.',
      registers: [registry],
    }),
    sweeperErrors: new Counter({
      name: 'gateway_sweeper_errors_total',
      help: 'Sweep passes that failed (e.g. Redis unavailable).',
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

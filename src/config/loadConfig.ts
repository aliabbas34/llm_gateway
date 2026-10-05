import type { ModelRef } from '../domain/types.js';
import { envSchema, type Env } from './schema.js';

/**
 * Typed, nested application config. Built once in the composition root and injected.
 * Contains secrets: never log it.
 */
export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly trustProxyHops: number;
    readonly corsAllowedOrigins: readonly string[];
  };
  readonly metrics: { readonly host: string; readonly port: number };
  readonly log: { readonly level: Env['LOG_LEVEL'] };
  readonly shutdown: { readonly drainTimeoutMs: number };
  readonly redis: { readonly url: string; readonly commandTimeoutMs: number };
  readonly postgres: {
    readonly url: string;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
  };
  readonly auth: {
    readonly jwtPublicKeyPem: string;
    readonly clockToleranceSec: number;
    readonly serviceApiKey: string;
  };
  readonly attempts: { readonly ttlSec: number };
  readonly models: { readonly primary: ModelRef; readonly fallbacks: readonly ModelRef[] };
  readonly systemPrompt: string;
  /** Only providers with credentials (or a URL, for the fake) are present. */
  readonly providers: {
    readonly groq?: ProviderEndpoint;
    readonly mistral?: ProviderEndpoint;
    readonly fake?: { readonly baseUrl: string };
  };
  readonly tokens: { readonly estimateMultiplier: number };
  readonly upstream: { readonly maxConnections: number };
  readonly rateLimits: { readonly ipPerMinute: number; readonly attemptPerMinute: number };
  readonly budget: {
    readonly minUsefulTokens: number;
    readonly reservationTtlMs: number;
    readonly maxStreamDurationMs: number;
  };
  readonly sweeper: { readonly intervalMs: number; readonly batchSize: number };
  readonly streaming: {
    readonly ttftTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly writeTimeoutMs: number;
  };
}

export interface ProviderEndpoint {
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate configuration from an env-like record.
 *
 * Pure: no reads of `process.env` unless the caller passes it, no I/O, no module-level state.
 * Error messages name the variable but never echo its value (values may be secrets).
 */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    http: {
      host: e.HOST,
      port: e.PORT,
      trustProxyHops: e.TRUST_PROXY_HOPS,
      corsAllowedOrigins: e.CORS_ALLOWED_ORIGINS,
    },
    metrics: { host: e.METRICS_HOST, port: e.METRICS_PORT },
    log: { level: e.LOG_LEVEL },
    shutdown: { drainTimeoutMs: e.SHUTDOWN_DRAIN_TIMEOUT_MS },
    redis: { url: e.REDIS_URL, commandTimeoutMs: e.REDIS_COMMAND_TIMEOUT_MS },
    postgres: {
      url: e.DATABASE_URL,
      poolMax: e.PG_POOL_MAX,
      statementTimeoutMs: e.PG_STATEMENT_TIMEOUT_MS,
    },
    auth: {
      jwtPublicKeyPem: e.JWT_PUBLIC_KEY,
      clockToleranceSec: e.JWT_CLOCK_TOLERANCE_SEC,
      serviceApiKey: e.SERVICE_API_KEY,
    },
    attempts: { ttlSec: e.ATTEMPT_TTL_SECONDS },
    models: { primary: e.PRIMARY_MODEL, fallbacks: e.FALLBACK_MODELS },
    systemPrompt: e.SYSTEM_PROMPT,
    providers: {
      ...(e.GROQ_API_KEY && { groq: { apiKey: e.GROQ_API_KEY, baseUrl: e.GROQ_BASE_URL } }),
      ...(e.MISTRAL_API_KEY && {
        mistral: { apiKey: e.MISTRAL_API_KEY, baseUrl: e.MISTRAL_BASE_URL },
      }),
      ...(e.FAKE_PROVIDER_BASE_URL && { fake: { baseUrl: e.FAKE_PROVIDER_BASE_URL } }),
    },
    tokens: { estimateMultiplier: e.TOKEN_ESTIMATE_MULTIPLIER },
    upstream: { maxConnections: e.UPSTREAM_MAX_CONNECTIONS },
    rateLimits: {
      ipPerMinute: e.RATE_LIMIT_IP_PER_MINUTE,
      attemptPerMinute: e.RATE_LIMIT_ATTEMPT_PER_MINUTE,
    },
    budget: {
      minUsefulTokens: e.BUDGET_MIN_USEFUL_TOKENS,
      reservationTtlMs: e.RESERVATION_TTL_MS,
      maxStreamDurationMs: e.MAX_STREAM_DURATION_MS,
    },
    sweeper: { intervalMs: e.SWEEPER_INTERVAL_MS, batchSize: e.SWEEPER_BATCH_SIZE },
    streaming: {
      ttftTimeoutMs: e.PROVIDER_TTFT_TIMEOUT_MS,
      idleTimeoutMs: e.PROVIDER_IDLE_TIMEOUT_MS,
      writeTimeoutMs: e.SSE_WRITE_TIMEOUT_MS,
    },
  };
}

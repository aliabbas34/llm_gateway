import { z } from 'zod';

/**
 * Environment-variable schema: the single source of truth for every tunable.
 *
 * Conventions:
 * - Every variable is parsed from a string; `z.coerce` / transforms turn it into the domain type.
 * - Defaults are the *safe* production value. Anything secret has no default.
 * - The parsed result is reshaped into a nested, typed `Config` in `loadConfig.ts`.
 */

/** Comma-separated list with a default; blanks are dropped. */
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

/** `provider:model`; the model part may itself contain ':' or '/' (vendor naming). */
const modelRef = z
  .string()
  .regex(/^[a-z0-9-]+:\S+$/, { message: 'must look like provider:model' })
  .transform((raw) => {
    const i = raw.indexOf(':');
    return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
  });

/** Empty strings (common in .env templates) count as "not set". */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

export const RESERVATION_TTL_MARGIN_MS = 5_000;

const envObject = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  // --- HTTP server -----------------------------------------------------------
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  /** Number of trusted reverse-proxy hops for X-Forwarded-For. 0 = trust none (ADR-0009). */
  TRUST_PROXY_HOPS: nonNegativeInt.default(0),
  /** Exact origins allowed by CORS. Empty = no cross-origin browser access. */
  CORS_ALLOWED_ORIGINS: csv(''),

  /** Prometheus /metrics listener (internal network only). */
  METRICS_HOST: z.string().min(1).default('0.0.0.0'),
  METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9464),

  // --- Logging ---------------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- Lifecycle -------------------------------------------------------------
  /** How long SIGTERM waits for in-flight streams before aborting them. */
  SHUTDOWN_DRAIN_TIMEOUT_MS: positiveInt.default(25_000),

  // --- Redis -----------------------------------------------------------------
  REDIS_URL: urlWithScheme(['redis:', 'rediss:']),
  /** Per-command timeout. Short on purpose: a slow Redis must fail closed fast (NFR5). */
  REDIS_COMMAND_TIMEOUT_MS: positiveInt.default(500),

  // --- Postgres --------------------------------------------------------------
  DATABASE_URL: urlWithScheme(['postgres:', 'postgresql:']),
  PG_POOL_MAX: positiveInt.default(10),
  PG_STATEMENT_TIMEOUT_MS: positiveInt.default(2_000),

  // --- Auth ------------------------------------------------------------------
  /** Ed25519 public key (SPKI PEM). Literal "\n" sequences are accepted for one-line env files. */
  JWT_PUBLIC_KEY: z
    .string()
    .transform((pem) => pem.replace(/\\n/g, '\n').trim())
    .refine((pem) => pem.startsWith('-----BEGIN PUBLIC KEY-----'), {
      message: 'must be an SPKI PEM public key',
    }),
  /** Allowed clock skew when checking `exp`. */
  JWT_CLOCK_TOLERANCE_SEC: nonNegativeInt.max(60).default(5),
  /** Shared secret the product backend uses for the close endpoint. */
  SERVICE_API_KEY: z.string().min(32, { message: 'must be at least 32 characters' }),

  // --- Attempts --------------------------------------------------------------
  /** Lifetime of per-attempt Redis keys, refreshed on use. Must outlive any attempt. */
  ATTEMPT_TTL_SECONDS: positiveInt.default(30 * 24 * 3600),

  // --- Models & providers ----------------------------------------------------
  /** `provider:model`. The client never chooses the model (SPEC §3). */
  PRIMARY_MODEL: z.string().default('groq:llama-3.3-70b-versatile').pipe(modelRef),
  /** Ordered failover candidates, `provider:model` CSV (FR6). Empty = no failover. */
  FALLBACK_MODELS: csv('mistral:mistral-small-latest').pipe(z.array(modelRef)),
  /** Prepended to every conversation; client system messages are dropped. */
  SYSTEM_PROMPT: z
    .string()
    .min(1)
    .default(
      'You are an AI assistant helping a student during a timed coding-interview practice ' +
        'session. Help them reason about the codebase and their approach. Be concise.',
    ),
  GROQ_API_KEY: optionalSecret,
  GROQ_BASE_URL: urlWithScheme(['https:', 'http:']).optional(),
  MISTRAL_API_KEY: optionalSecret,
  MISTRAL_BASE_URL: urlWithScheme(['https:', 'http:']).optional(),
  /** OpenAI-compatible fake provider (scripts/fake-provider-server.ts), for e2e and load tests. */
  FAKE_PROVIDER_BASE_URL: urlWithScheme(['http:', 'https:']).optional(),

  // --- Rate limits (FR4) -----------------------------------------------------
  /** Requests per minute per client IP, checked before auth. */
  RATE_LIMIT_IP_PER_MINUTE: positiveInt.default(120),
  /** Requests per minute per attempt, checked after auth + validation. */
  RATE_LIMIT_ATTEMPT_PER_MINUTE: positiveInt.default(20),

  // --- Budget (FR5) -----------------------------------------------------------
  /** Reject a request whose effective completion budget would be at or below this. */
  BUDGET_MIN_USEFUL_TOKENS: nonNegativeInt.default(16),
  /** How long a reservation lives before the sweeper may charge it (ADR-0011). */
  RESERVATION_TTL_MS: positiveInt.default(360_000),
  /** Hard cap on one stream's duration; must be shorter than RESERVATION_TTL_MS. */
  MAX_STREAM_DURATION_MS: positiveInt.default(300_000),

  // --- Streaming timeouts (FR6) ------------------------------------------------
  /** Upstream request sent → first chunk. Exceeding it is a retryable failure (failover). */
  PROVIDER_TTFT_TIMEOUT_MS: positiveInt.default(10_000),
  /** Max silence between upstream chunks once streaming. */
  PROVIDER_IDLE_TIMEOUT_MS: positiveInt.default(20_000),
  /** A client that does not drain its socket for this long is disconnected (slow consumer). */
  SSE_WRITE_TIMEOUT_MS: positiveInt.default(30_000),

  // --- Sweeper (crash recovery, ADR-0005) ------------------------------------------
  SWEEPER_INTERVAL_MS: positiveInt.default(15_000),
  SWEEPER_BATCH_SIZE: positiveInt.max(10_000).default(200),

  /**
   * Max concurrent connections per provider origin. Each live stream holds one (HTTP/1.1), so this
   * must exceed the per-instance stream target (NFR1: 500).
   */
  UPSTREAM_MAX_CONNECTIONS: positiveInt.default(1024),

  // --- Token accounting ------------------------------------------------------
  /** Safety factor on local input-token estimates (ADR-0008). */
  TOKEN_ESTIMATE_MULTIPLIER: z.coerce.number().min(1).max(3).default(1.1),
});

function urlWithScheme(schemes: readonly string[]) {
  return z.string().refine(
    (raw) => {
      try {
        return schemes.includes(new URL(raw).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a URL with scheme ${schemes.join(' or ')}` },
  );
}

/**
 * Cross-field rules. ADR-0011: a live stream must never outlive its reservation, or the sweeper
 * could charge it in full while it is still running. The margin covers settle latency and
 * Redis/host clock skew (both milliseconds); defaults leave 60 s.
 */
export const envSchema = envObject.superRefine((e, ctx) => {
  if (e.RESERVATION_TTL_MS < e.MAX_STREAM_DURATION_MS + RESERVATION_TTL_MARGIN_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESERVATION_TTL_MS'],
      message: `must be at least MAX_STREAM_DURATION_MS + ${RESERVATION_TTL_MARGIN_MS} (ADR-0011)`,
    });
  }
});

export type Env = z.infer<typeof envSchema>;

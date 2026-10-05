# LLM Gateway — Implementation Plan

Companion to [SPEC.md](SPEC.md). This file is the living progress log: each phase
is ticked only when **lint, typecheck and all tests are green**.

---

## 1. Phase progress

| Phase | Scope                                                                                                                                                                       | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Scaffold, config (`loadConfig` + zod), `buildApp`, `/healthz`, CI workflow file                                                                                             | ✅     | 2026-10-03 · 31 tests (unit) green, lint/format/typecheck/build clean; coverage domain+application 100 %. `/readyz` + Lifecycle, error taxonomy, CORS, request-id, access log landed early (needed by `/healthz` tests). ADRs 0001, 0007, 0009, 0014, 0015.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P2    | Docker Compose (Redis, Postgres), migrations, ledger repo, JWT auth, scripts (gen-keys, mint-token, close-attempt), close endpoint                                          | ✅     | 2026-10-03 · 75 tests (unit + integration on real Redis/PG) green. Close endpoint uses a plain `SET` (atomic + idempotent), so `close_attempt.lua` from §4 was dropped (YAGNI). `isClosed` dropped from the port: the closed check lives in the reserve script. ADRs 0012, 0016.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P3    | Provider port, OpenAI-compatible base adapter, Groq + second + fake, registry, SSE parser/writer, normalization, token counter, contract suite, real-socket disconnect test | ✅     | 2026-10-03 · 172 tests green (unit, contract ×4 adapters, integration, e2e real-socket disconnect). **Fallback = Mistral, not Cerebras**: Cerebras ended its free tier 2026-07-16 (ADR-0002). Found and fixed a **quadratic-BPE CPU DoS** (32 k-char run = 3.8 s blocking) by chunked tokenization (ADR-0008). A minimal passthrough chat route landed here (needed for the disconnect test). Global fetch kept (undici default pool is unbounded per origin), so no undici dependency.                                                                                                                                                                                                                                                                                                                                                           |
| P4    | Rate limiting (per-IP pre-auth, per-attempt post-auth)                                                                                                                      | ✅     | 2026-10-03 · 185 tests green. **GCRA** instead of the planned sliding-window counter: one key, exact Retry-After, atomic, Redis `TIME` clock (ADR-0003). 50-parallel test → exactly `limit` allowed. Pipeline order proved pairwise in `test/unit/http/pipeline.test.ts`. Lua copied to dist at build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P5    | Budget reserve / reconcile (Lua) + ledger rows, happy path, concurrency test                                                                                                | ✅     | 2026-10-03 · 217 tests green. Lua `reserve`/`settle`/`claim_expired` + `RedisBudgetStore`; `ReservationHandle` (settle-once) + try/finally in the service; async `UsageRecorder`. Concurrency: 100 parallel reserves, a 200-op seeded reserve/settle storm with a live sampler, and 60 parallel HTTP chats on one attempt (ledger Σcharged + Redis remaining = initial). Composition extracted to `src/gateway.ts` so e2e tests run production wiring. Bugs caught by tests: sink errors were misclassified as provider errors (fixed). Reservation hash value is JSON (cjson), not `amount                                                                                                                                                                                                                                                       | expiresAt`. ADRs 0004, 0005, 0010, 0011, 0013. |
| P6    | Failure paths (disconnect, mid-stream error, Redis down, Postgres down, double reconcile) + sweeper                                                                         | ✅     | 2026-10-03 · 225 tests green. Failure path → test: client disconnect → `e2e/failurePaths` (+ real-socket `e2e/clientDisconnect`); mid-stream error / dropped connection → `e2e/failurePaths`; **gateway crash → `e2e/crashRecovery` (a real child process SIGKILLed mid-stream, swept after TTL)**; Redis down → `e2e/failurePaths` + `integration/*`; Postgres down → `e2e/failurePaths`; double reconcile → `integration/budgetStore` + concurrency storm. `ReservationSweeper` on every instance (off in tests unless needed). TTL margin rule relaxed from 30 s to 5 s minimum (ADR-0011 updated).                                                                                                                                                                                                                                            |
| P7    | Failover before first byte, TTFT + idle timeouts, fake-provider scenarios                                                                                                   | ✅     | 2026-10-03 · 248 tests green. Service split for SRP: `ModelStreamer` (one model, commit decision, error classification), `Watchdog` (TTFT/idle, paused during client writes), `ChatCompletionService` (reservation + failover loop + settle + ledger). Request deadline = MAX_STREAM_DURATION_MS. Slow-consumer guard in `SseWriter`. e2e over HTTP: 503/429 → fallback, hung headers → TTFT → fallback (+ upstream cancelled), 400 → no failover, all down → 502 + release, stall → idle timeout event. ADR-0017.                                                                                                                                                                                                                                                                                                                                |
| P8    | Logs (redaction, no-content test), request IDs, metrics, e2e suite                                                                                                          | ✅     | 2026-10-03 · 260 tests green. prom-client metrics in an injected registry, served on a separate port (9464); decorators `InstrumentedProvider` + `InstrumentedChatCompletion` (OCP/DIP). `safeError` for log-safe error summaries. **No-content log test** at `trace` across 7 content-bearing paths, mutation-checked: it fails when a real leak is injected. Found + fixed: hijacked SSE streams aborted by the client had no access-log line (Fastify `onRequestAbort` does not fire after hijack) → raw `close` listener logs 499.                                                                                                                                                                                                                                                                                                            |
| P9    | Graceful shutdown, Dockerfile, CD workflow file (deploy stubbed), load test                                                                                                 | ✅     | 2026-10-03 · 277 tests green (1 Linux-only SIGTERM test skipped on Windows). `DrainableChatCompletion` + ordered shutdown (ADR-0018), verified in-process, by real SIGTERM in a Linux container (exit 0, `shutting_down` event, ledger row) and in CI (Docker smoke job). Dockerfile multi-stage/non-root/healthcheck; compose `app` profile; CD workflow (deploy stubbed). **Load test** (docs/LOAD_TEST.md): NFR3 met uncontended and up to ~10 concurrent on this 4-thread laptop (p95 14.7 / 43.2 ms); CPU-bound at ~230 req/s; 500 concurrent ~10 s streams all succeed. Load/demo found and fixed 5 real issues: GCRA `PX 0`, ~15 ms per upstream call from the default fetch dispatcher (ADR-0019), a runtime dependency listed as dev-only, an extra Redis round trip on reserve, and ledger pool exhaustion on bursts (batched INSERTs). |
| P10   | README, ARCHITECTURE (mermaid), HARDEST_PROBLEM (STAR), COMPARISON_GUIDE, demo script                                                                                       | ✅     | 2026-10-03 · README, ARCHITECTURE (component, layers, happy path, failover, budget + crash sequences), HARDEST_PROBLEM (STAR), LOAD_TEST, COMPARISON_GUIDE (10 days), 19 ADRs, `scripts/demo.sh` (verified end to end, exit 0).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Gate per phase: `npm run lint && npm run typecheck && npm test` (unit +
integration + contract + e2e as they come into existence).

---

## 2. Module layout

```
src/
  config/
    schema.ts                 zod schema for all env vars (single source of truth)
    loadConfig.ts             loadConfig(env = process.env): Config — pure, no side effects at import
  domain/
    types.ts                  ChatMessage, ChatRequest (normalized), ChatChunk, Usage, AttemptClaims, Outcome
    errors.ts                 GatewayError (code, httpStatus, retryAfterSec?) + subclasses
    providerErrors.ts         ProviderError with kind: rate_limited | server_error | timeout | connection | client_error | protocol_error
    ports.ts                  LlmProvider, TokenVerifier, RateLimiter, BudgetStore, AttemptStatusStore,
                              UsageLedger, TokenCounter, Clock, IdGenerator
  application/
    ChatCompletionService.ts  orchestrates: count → reserve → provider stream w/ failover → reconcile → ledger
    AttemptService.ts         close attempt (idempotent)
    reservation.ts            ReservationHandle: settle-once (reconcile | release) guarded by try/finally
    failover.ts               ordered model chain, first-byte gate, retryable classification
    messagePolicy.ts          drop system msgs, keep user/assistant, prepend configured system prompt
    ReservationSweeper.ts     periodic claim of expired reservations (uses BudgetStore + UsageLedger)
    StreamRegistry.ts         in-process set of active streams (for shutdown drain/abort)
  infrastructure/
    redis/
      client.ts               ioredis factory (offline queue OFF, command timeout) + defineCommand loading
      RedisBudgetStore.ts     implements BudgetStore
      RedisAttemptStatusStore.ts implements AttemptStatusStore
      RedisRateLimiter.ts     implements RateLimiter (sliding-window strategy)
      keys.ts                 key builders (only place key strings are formed)
      lua/reserve.lua  reconcile.lua  claim_expired.lua  rate_limit_gcra.lua
    postgres/
      pool.ts                 pg Pool factory
      PgUsageLedger.ts        implements UsageLedger (INSERT … ON CONFLICT (request_id) DO NOTHING)
    providers/
      OpenAiCompatibleProvider.ts  base adapter: raw fetch, SSE parse, error classification, usage extraction hooks
      GroqProvider.ts         vendor quirks (usage location, base URL)
      <Second>Provider.ts     vendor quirks for the fallback vendor (named after the ADR decision)
      FakeProvider.ts         in-process scriptable provider (scenarios)
      ProviderRegistry.ts     factory: config → Map<modelRef, LlmProvider>
    auth/JwtTokenVerifier.ts  jose EdDSA verify, aud/exp, claim schema (zod)
    tokenizer/GptTokenCounter.ts  implements TokenCounter (approximate tokenizer + safety margin)
    system/SystemClock.ts, UuidGenerator.ts
  http/
    app.ts                    buildApp(deps): FastifyInstance — no I/O on construction
    routes/chatCompletions.ts parse → ChatCompletionService → SSE writer
    routes/attempts.ts        close endpoint (service-key guarded)
    routes/health.ts          /healthz, /readyz
    plugins/requestId.ts  ipRateLimit.ts  auth.ts  attemptRateLimit.ts  cors.ts  errorHandler.ts  serviceKey.ts
    schemas/chat.ts           zod request schema (FR3 limits)
    sse/SseParser.ts          incremental parser, handles events split across chunks
    sse/SseWriter.ts          OpenAI-format re-emitter, backpressure aware, deferred headers
  observability/
    logger.ts                 pino options: redaction paths, serializers that never include bodies
    metrics.ts                prom-client registry + metric definitions (injected, not global)
    InstrumentedProvider.ts   decorator around LlmProvider (latency, TTFT, errors by kind)
  server.ts                   composition root: loadConfig → real adapters → buildApp → listen → shutdown
scripts/
  gen-keys.ts  mint-token.ts  close-attempt.ts  fake-provider-server.ts  demo.sh
  load-test/run.ts            autocannon against gateway + fake provider server
migrations/                   node-pg-migrate, plain SQL
test/
  unit/  integration/  e2e/  contract/  concurrency/  helpers/
docs/
  SPEC.md  PLAN.md  ARCHITECTURE.md  HARDEST_PROBLEM.md  COMPARISON_GUIDE.md  adr/
```

Dependency rule (enforced by an ESLint `no-restricted-imports` rule):
`domain` ← `application` ← `infrastructure` / `http` / `observability` ← `server.ts`.
`domain` and `application` never import `infrastructure`, `http`, `ioredis`, `pg`,
`fastify` or `fetch`-using code.

### Ports (kept small)

```ts
LlmProvider        { readonly name: string; streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ChatChunk> }  // throws ProviderError
TokenVerifier      { verify(token: string): Promise<AttemptClaims> }                       // throws UnauthorizedError
RateLimiter        { hit(key: RateLimitKey): Promise<RateLimitDecision> }                   // {allowed, retryAfterSec}
BudgetStore        { reserve(r): Promise<ReserveResult>; reconcile(r): Promise<SettleResult>;
                     release(r): Promise<SettleResult>; sweepExpired(limit): Promise<ExpiredReservation[]> }
AttemptStatusStore { close(attemptId): Promise<void>; isClosed(attemptId): Promise<boolean> }
UsageLedger        { record(entry: UsageEntry): Promise<void> }
TokenCounter       { countMessages(msgs: ChatMessage[]): number }
Clock              { nowMs(): number; monotonicMs(): number }
IdGenerator        { next(): string }
```

### Pipeline

Fastify hooks, in this order, scoped to the chat route's encapsulated plugin:

| #   | step                                       | hook                                                                     | failure                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------- |
| 1   | requestId                                  | `genReqId` + `onRequest` (echo `x-request-id`)                           | —                                             |
| 2   | IP rate limit                              | `onRequest`                                                              | 429 + Retry-After                             |
| 3   | auth (JWT)                                 | `onRequest`                                                              | 401                                           |
| 4   | validation (body limit 256 KB, zod schema) | Fastify `bodyLimit` + validator                                          | 400                                           |
| 5   | attempt rate limit                         | `preHandler`                                                             | 429 + Retry-After                             |
| 6   | reserve                                    | first statement of `ChatCompletionService.stream()` inside `try/finally` | 403 closed / 403 budget_exhausted / 503 Redis |
| 7   | handler                                    | stream + reconcile + ledger                                              | 502 before first byte / SSE error after       |

Step 6 deliberately lives in the service rather than a hook so a single
`try/finally` owns the reservation from creation to settlement (ADR-0004).

---

## 3. Ports & processes (local)

| process              | port             | notes                                                       |
| -------------------- | ---------------- | ----------------------------------------------------------- |
| gateway HTTP         | 8080             | public API                                                  |
| gateway metrics      | 9464             | `/metrics`, separate listener so it is not exposed publicly |
| fake provider server | 8090             | OpenAI-compatible, scenario chosen via `model` name         |
| Redis (compose)      | host 6380 → 6379 | non-default host port to avoid clashing with local installs |
| Postgres (compose)   | host 5433 → 5432 | same reason                                                 |

---

## 4. Redis key design

All per-attempt keys share the hash tag `{att:<attemptId>}` so every per-attempt
Lua script touches a single cluster slot. `attemptId` is validated as
`^[A-Za-z0-9_-]{1,64}$` before any key is built (no injection into key names).

| key                    | type         | contents                                                                                                   | TTL                                  |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `gw:{att:<id>}:budget` | string (int) | remaining tokens (after outstanding reservations)                                                          | `ATTEMPT_TTL` (refreshed on reserve) |
| `gw:{att:<id>}:status` | string       | `closed` (absent ⇒ open)                                                                                   | `ATTEMPT_TTL`                        |
| `gw:{att:<id>}:resv`   | hash         | reservationId → JSON `{r: reserved, i: input, e: expiresAtMs, c: createdAtMs, s: studentId, q: requestId}` | `ATTEMPT_TTL`                        |
| `gw:{att:<id>}:rl`     | string       | GCRA theoretical arrival time (per attempt)                                                                | ≤ 1 period                           |
| `gw:rl:ip:<ip>`        | string       | GCRA theoretical arrival time (per IP)                                                                     | ≤ 1 period                           |
| `gw:resv:expiry`       | zset         | member = attemptId and reservationId joined by a pipe; score = provisional expiresAtMs                     | none                                 |

Lua scripts (`defineCommand`, all time from **Redis `TIME`**):

- **reserve.lua** (keys: status, budget, resv) — closed? → `attempt_closed`;
  `SET budget token_budget NX`; `effective = min(cap, remaining − input)`;
  `effective ≤ MIN_USEFUL` → `budget_exhausted`; `DECRBY budget input+effective`;
  `HSET resv id amount|expiresAt`; returns `{ok, reserved, effective, expiresAt}`.
- **reconcile.lua** (keys: budget, resv) — `HGET` id; missing ⇒ `already_settled`
  (idempotent no-op); else `charge = min(actual, reserved)`,
  `INCRBY budget reserved − charge`, `HDEL`.
- **claim_expired.lua** (keys: budget, resv) — `HGET`; missing ⇒ `already_settled`;
  not yet expired per Redis `TIME` ⇒ `not_expired` + real expiresAt; else charge in
  full (no refund), `HDEL`, return metadata for the ledger row.
- **rate_limit_gcra.lua** — GCRA (one key holding the theoretical arrival time), returns
  `{allowed, retryAfterMs}`. Chosen in P4 over a sliding-window counter: exact Retry-After, one key.
- ~~close_attempt.lua~~ — dropped in P2: a single `SET status closed EX ttl` is already atomic and idempotent.

**Expiry index ordering (crash safety).** The global zset lives in a different
slot, so it cannot be in the same script. The gateway **pipelines `ZADD` before
`reserve`** (index-before-data). A crash between them leaves an index entry
with no hash entry, which the sweeper drops as `already_settled`. The reverse
order could leave a reservation that is never swept (budget leak). The zset
score is provisional (local clock + skew margin); the hash holds the
authoritative expiry, and the sweeper re-scores entries that report
`not_expired`.

**Sweeper.** Every instance runs it on an interval: `ZRANGEBYSCORE -inf <now>
LIMIT n` → `claim_expired` per entry → winners write a ledger row
`expired_unreconciled` → `ZREM`. Atomic `HDEL` inside the script means two
instances can never both claim the same reservation.

**Invariant.** `budget + Σ outstanding reservations + Σ charged = initial`.
Every operation preserves it, and `budget` never goes below 0 because reserve
only subtracts what it has verified is available.

---

## 5. Postgres

`usage_ledger(id bigserial, request_id text UNIQUE, attempt_id, student_id,
model, provider, input_tokens, output_tokens, reserved_tokens, charged_tokens,
outcome usage_outcome, latency_ms, ttft_ms, failover_count, created_at)` with
index `(attempt_id, created_at)`.

`usage_outcome` enum: `completed`, `client_disconnected`, `upstream_error`
(all candidates failed before first byte), `stream_error` (failed after first
byte), `budget_exhausted`, `attempt_closed`, `shutdown_aborted`,
`expired_unreconciled`.

Writes are fire-and-forget after the response (never block the stream); a failure
is logged and counted in `ledger_write_failures_total`. Inserts use
`ON CONFLICT (request_id) DO NOTHING`, so retries are idempotent.

---

## 6. Key design choices (each gets an ADR)

| ADR  | decision                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | Record architecture decisions (format)                                                                                                  |
| 0002 | Fallback provider vendor: **Mistral** (Cerebras is no longer free; see ADR)                                                             |
| 0003 | Clock source: Redis `TIME` for all cross-instance decisions; injected `Clock` only for local durations + provisional zset score         |
| 0004 | Reserve lives inside the service's `try/finally`, not a Fastify hook                                                                    |
| 0005 | Expiry index written before reservation (pipelined), sweeper re-scores                                                                  |
| 0006 | Budget exhausted → 403 `budget_exhausted` (not 429: retrying does not help)                                                             |
| 0007 | Oversized body → 400, not Fastify's default 413 (spec FR3)                                                                              |
| 0008 | Token counting: approximate tokenizer + safety margin; hard limit holds because charge ≤ reserved and provider `max_tokens = effective` |
| 0009 | Client IP: `trustProxy` off by default, configurable hop count                                                                          |
| 0010 | Ledger write is async, best effort, no outbox in v1                                                                                     |
| 0011 | Max stream duration < reservation TTL (so a live stream can't be swept)                                                                 |
| 0012 | Integration tests use docker compose services (CI: GitHub `services:`), not testcontainers                                              |
| 0013 | Rows for rejected requests: ledger only for requests that pass auth + validation; 401/429/400 go to metrics/logs only                   |
| 0014 | Request ids generated server-side only (they key the ledger)                                                                            |
| 0015 | Version pins that deviate from latest (TypeScript 6, ioredis 5, @types/node 22)                                                         |
| 0016 | Redis noeviction + AOF are correctness requirements                                                                                     |
| 0017 | Failover and timeout semantics                                                                                                          |
| 0018 | Graceful shutdown sequence                                                                                                              |
| 0019 | Dedicated undici connection pool for providers                                                                                          |

---

## 7. Testing strategy

- **unit** — domain, application (with in-memory fakes of every port), SSE
  parser (chunk-boundary fuzzing), message policy, config.
- **contract** — one shared suite run against `FakeProvider` and each
  OpenAI-compatible adapter pointed at the fake HTTP server; asserts identical
  chunk normalization and error classification.
- **integration** — real Redis + Postgres: Lua scripts, rate limiter, ledger,
  sweeper (two sweepers racing), Redis-down / PG-down behaviour.
- **concurrency** — ≥ 50 parallel reserves on one attempt: budget never
  negative, total charged ≤ initial.
- **e2e** — real HTTP socket against `buildApp` + fake provider server:
  happy path, failover, mid-stream error, client disconnect, close attempt,
  log-capture test (no prompt/completion text in logs).
- Coverage threshold ≥ 85 % on `src/domain/**` and `src/application/**`
  (enforced in vitest config).

Scripts: `lint`, `format:check`, `typecheck`, `test:unit`, `test:integration`,
`test:e2e`, `test` (all), `test:coverage`, `migrate`, `dev`, `build`, `start`,
`load-test`. CI workflow mirrors them with Redis + Postgres service containers.

---

## 8. Risks

| risk                                                                         | mitigation                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Tokenizer mismatch (Llama-family models vs JS tokenizer)                     | charge is capped at reserved; safety margin on input estimate; provider-reported usage preferred |
| Groq / fallback put usage in different places in the stream                  | adapter hook `extractUsage`; fallback to counting streamed tokens                                |
| Long streams outliving reservation TTL                                       | enforced max stream duration < TTL (ADR-0011)                                                    |
| Cluster cross-slot: global zset vs per-attempt keys                          | index-before-data ordering + idempotent claim (ADR-0005)                                         |
| ioredis queues commands while disconnected ⇒ hangs instead of failing closed | `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `commandTimeout`                         |
| SSE backpressure with 500 streams                                            | honour `write() === false` → await `drain`; abort on close                                       |
| Outbound connection pool to providers                                        | dedicated undici `Agent` with sized `connections`                                                |
| Fastify `close()` vs hijacked streaming replies                              | own `StreamRegistry` drains/aborts before `app.close()`                                          |
| Windows dev host: no real SIGTERM                                            | shutdown logic is a callable function, tested directly; signal wiring tested in Docker           |
| Free-tier terms of the fallback vendor change                                | verified at P3 with date in ADR-0002; vendor is config, not code                                 |
| `exactOptionalPropertyTypes` friction with libraries                         | narrow wrappers at infrastructure boundaries, no `any`                                           |

---

## 9. Versions

Exact versions are pinned (no `^`/`~`) in `package.json` at P1 from the npm
registry on that date; Node pinned via `.nvmrc` (22 LTS) and `engines`.

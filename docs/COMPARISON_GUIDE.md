# Comparison guide

For comparing _your_ sprint implementation with this reference after you finish. For each of the
10 sprint days: where it lives here, the decisions and why, the tests that prove it, and
questions to ask yourself. Paths are relative to the repo root. ADRs are in `docs/adr/`.

> This reference was built in 10 phases (`docs/PLAN.md`) that map onto your days. Day 1 here also
> includes the error taxonomy and request-id/CORS plumbing that later days rely on.

---

## Day 1: spec, scaffold, passthrough

**Files**

- `docs/SPEC.md`, `docs/PLAN.md`
- `package.json` (pinned, `save-exact`), `tsconfig.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- `eslint.config.js` (strict type-checked, `no-explicit-any`, layering rule, disable-needs-description), `vitest.config.ts` (projects + coverage thresholds)
- `src/config/schema.ts`, `src/config/loadConfig.ts`
- `src/http/app.ts` (`buildApp(deps)`), `src/server.ts`
- `src/domain/errors.ts`, `src/http/plugins/{errorHandler,requestId,accessLog,cors}.ts`
- `src/http/routes/health.ts`, `.github/workflows/ci.yml`
- The passthrough chat route arrived with providers: `src/http/routes/chatCompletions.ts`

**Decisions and why**

- `loadConfig(source)` is pure and takes the env as a parameter, so tests pass plain objects and
  nothing reads `process.env` at import time. Error messages name variables but never echo
  values (secrets).
- One error taxonomy (`GatewayError` with `code` / `httpStatus` / `publicMessage` /
  `retryAfterSec`). The error handler is the _only_ place that maps errors to HTTP. Anything
  that isn't a `GatewayError` is a bug and becomes a 500.
- Request ids are generated server-side only, because they are the ledger's unique key (ADR-0014).
- Fastify's 413/415 become 400 per FR3 (ADR-0007).
- The ESLint layering rule makes "domain/application never import infrastructure" a build failure,
  not a convention.

**Tests:** `test/unit/config/loadConfig.test.ts`, `test/unit/http/app.test.ts` (health, 404, request id, 4xx mapping, CORS), `test/unit/domain/errors.test.ts`

**Ask yourself**

1. Can your app be constructed in a test without a network, a `.env` file, or module-level side effects?
2. Where is the _single_ place an error becomes an HTTP status? What does a client see for a bug vs. a bad request?
3. If a client sends `x-request-id: abc` twice, what happens to your ledger?
4. Does a typo in an env var fail at startup with the variable's name, and without printing its value?

---

## Day 2: compose, migrations, JWT, close endpoint

**Files**

- `docker-compose.yml` (Redis `noeviction` + AOF, Postgres, non-default host ports)
- `migrations/1759478400000_usage-ledger.sql`, `src/infrastructure/postgres/{pool,migrate,PgUsageLedger,PgHealthCheck}.ts`, `src/migrate.ts`
- `src/infrastructure/auth/JwtTokenVerifier.ts`, `src/http/plugins/{auth,serviceKey}.ts`
- `src/infrastructure/redis/{client,keys,failClosed,RedisAttemptStatusStore}.ts`
- `src/application/AttemptService.ts`, `src/http/routes/attempts.ts`
- `scripts/{gen-keys,mint-token,close-attempt}.ts`, `scripts/lib/tokens.ts`

**Decisions and why**

- JWT: `jose` with `algorithms: ['EdDSA']` (no algorithm confusion), `audience`, required
  `exp`/`sub`, then a zod schema for custom claims. Every failure is a 401 whose _internal_
  message is the jose code, and the token is never logged.
- The service key is compared with `timingSafeEqual` over **SHA-256 digests**, so the buffers
  always have equal length and length isn't leaked.
- Closing an attempt is a single `SET … EX`: atomic and naturally idempotent. No Lua was needed,
  so none was written (YAGNI).
- Redis client tuned to **fail closed**: no offline queue, `maxRetriesPerRequest: 1`, a command
  timeout, and `failClosed()` wraps every call into a 503.
- The ledger schema enforces `charged ≤ reserved` and an outcome enum; `request_id` is UNIQUE.
- Integration tests run against compose services, not testcontainers (ADR-0012).
- `noeviction` and persistence are correctness requirements, not tuning (ADR-0016).

**Tests:** `test/unit/infrastructure/JwtTokenVerifier.test.ts` (expired, wrong aud, wrong key, HS256 confusion, bad claims), `test/unit/http/{auth,attempts}.test.ts`, `test/integration/{redis,ledger}.test.ts`

**Ask yourself**

1. What does your verifier do with an `HS256` token signed with the public key as the HMAC secret?
2. Does your service-key comparison leak the key's length through timing?
3. What happens to a request when Redis is unreachable: hang, 500, or 503 + Retry-After? How fast?
4. If Redis evicts an attempt's budget key under memory pressure, what does the student get next?
5. Is your close endpoint idempotent, and does it authenticate _before_ validating the path?

---

## Day 3: providers, SSE, token counting

**Files**

- `src/domain/ports.ts` (`LlmProvider`, `TokenCounter`), `src/domain/providerErrors.ts`
- `src/infrastructure/providers/{OpenAiCompatibleProvider,GroqProvider,MistralProvider,FakeProvider,ProviderRegistry}.ts`
- `src/http/sse/{SseParser,SseWriter}.ts`, `src/infrastructure/tokenizer/GptTokenCounter.ts`
- `scripts/lib/fakeProviderServer.ts` (misbehaviour scenarios chosen by model name)

**Decisions and why**

- Template method: the base adapter owns fetch, SSE parsing, `[DONE]` handling and error
  classification; vendors override `buildBody` / `extractUsage`. A new vendor means one class
  plus one registry line (OCP).
- **The fallback is Mistral, not Cerebras**: Cerebras ended its free tier in July 2026. Verified
  and recorded with sources (ADR-0002).
- A normalized `ChatChunk` union (`delta | finish | usage`); empty and role-only deltas are
  dropped in the adapter.
- Upstream error _bodies_ are never read into errors, because they may echo the prompt.
  Unconsumed bodies are cancelled.
- The SSE parser is incremental: CR/LF/CRLF, CRLF split across chunks, BOM, multi-line data,
  comments, multi-byte UTF-8 split across byte chunks (streaming `TextDecoder`).
- **Chunked tokenization**: BPE is quadratic on long single tokens (3.8 s for 32 k identical
  characters, measured). 512-char chunks make it linear (ADR-0008).
- An abort with a `ProviderError` reason is re-thrown unchanged, which is how timeouts become
  classified errors later without adapter changes.

**Tests:** `test/contract/providerContract.ts` + `providers.contract.test.ts` (the same suite against generic, Groq, Mistral over real HTTP, and the in-process fake), `test/contract/adapterSpecifics.test.ts`, `test/unit/http/SseParser.test.ts` (every split point, 200 random partitions), `test/unit/infrastructure/GptTokenCounter.test.ts`, `test/e2e/clientDisconnect.test.ts` (real sockets: upstream cancelled < 1 s)

**Ask yourself**

1. Do all your adapters (and your fake) classify a 429, a 503, a refused connection and a malformed stream _identically_? Is there one test suite that proves it?
2. What does your parser do when `\r` arrives at the end of one chunk and `\n` at the start of the next? An emoji split across two TCP reads?
3. How long does your tokenizer take on `"x".repeat(32000)`? On the event loop?
4. When the client disconnects, how many milliseconds until the provider request is actually cancelled? Did you measure it over a real socket?
5. Could a provider's error body (which may echo the prompt) end up in your logs?

---

## Day 4: rate limiting

**Files:** `src/infrastructure/redis/lua/rate_limit_gcra.lua`, `src/infrastructure/redis/{RedisRateLimiter,commands}.ts`, `src/http/plugins/rateLimit.ts`, `src/domain/ports.ts` (`RateLimiter`)

**Decisions and why**

- **GCRA** over a sliding-window counter: one key, an exact Retry-After, bursts up to the limit,
  atomic. Time comes from Redis `TIME` (ADR-0003).
- The IP limit runs in `onRequest` **before** auth, protecting JWT verification. The attempt
  limit runs in `preHandler`, after validation, so invalid bodies don't spend quota.
- Client IP comes from `TRUST_PROXY_HOPS` (default 0). Trusting `X-Forwarded-For` blindly would
  make the limit spoofable (ADR-0009).
- Lua scripts are registered with `defineCommand` and typed via module augmentation, with no casts.

**Tests:** `test/integration/rateLimiter.test.ts` (burst, refill, 50 parallel → exactly `limit`, IPv6), `test/unit/http/pipeline.test.ts` (each adjacency of the pipeline proven by making two steps fail at once)

**Ask yourself**

1. With 50 simultaneous requests and a limit of 10, how many get through? Prove it against real Redis.
2. Which clock decides your windows when 3 instances have skewed clocks?
3. Can a client bypass your IP limit by sending `X-Forwarded-For`?
4. Does a malformed request consume the attempt's quota? Should it?
5. What does your limiter do when Redis is down: allow everything, or fail closed?

---

## Day 5: budgets (happy path) and ledger

**Files**

- `src/infrastructure/redis/lua/{reserve,settle}.lua`, `src/infrastructure/redis/RedisBudgetStore.ts`
- `src/application/{ChatCompletionService,ReservationHandle,UsageRecorder}.ts`
- `src/gateway.ts` (composition root shared by `server.ts` and e2e tests)

**Decisions and why**

- Reserve the worst case (`input + min(cap, remaining − input)`) in one Lua script with `SET NX`
  initialisation, and pass `max_tokens = effective` to the provider. The provider can't
  overspend the reservation.
- Settle charges `min(actual, reserved)` and deletes the reservation **in the same atomic
  step**, which is what makes it idempotent.
- `ReservationHandle` settles once. A single `try/finally` in the service owns it (ADR-0004);
  reserve isn't a hook.
- Reconcile happens **before** `[DONE]` is written, so the student's next request already sees
  the refund.
- Ledger writes are fire-and-forget and **batched** into multi-row INSERTs (≤ 50 ms buffer),
  flushed on shutdown (ADR-0010). Batching was added after a sweeper burst exhausted the pg pool.
  Rejections get rows too (ADR-0013).
- 403 for `budget_exhausted` (ADR-0006).

**Tests:** `test/integration/budgetStore.test.ts`, `test/concurrency/budget.test.ts` (100 parallel reserves, 200-op seeded storm with live sampler), `test/concurrency/gatewayBudget.test.ts` (60 parallel HTTP chats; ledger Σ + Redis remaining = initial), `test/e2e/budget.e2e.test.ts`, `test/unit/application/ChatCompletionService.test.ts`

**Ask yourself**

1. **Where does your reservation get released if the handler throws** between reserve and stream end?
2. Two tabs, 50 tokens left, both requests arrive in the same millisecond: what happens, and where is that decided?
3. Can a second token with a larger `token_budget` top up an existing attempt?
4. If your input-token estimate is 30 % too low, can the student exceed the budget? Why not?
5. Does the student's next request see the refund from the previous one, or race it?
6. 500 ledger rows need writing in the same second (a sweeper burst). What happens to your pg pool?

---

## Day 6: budget failure paths

**Files:** `src/infrastructure/redis/lua/claim_expired.lua`, `RedisBudgetStore.sweepExpired`, `src/application/ReservationSweeper.ts`, the failure branches in `ChatCompletionService`

**Decisions and why**

- Index-before-data ordering for the global expiry zset (cross-slot), atomic per-attempt claims,
  and re-scoring of provisional scores (ADR-0005).
- **Whoever settles writes the ledger row**: the request on `settled`, the sweeper on `claimed`.
  A request whose settle fails (Redis down at the end) writes nothing; the sweeper will.
- Charge rules per outcome (ADR-0013): disconnect and mid-stream error → input + streamed
  estimate; before the first byte → 0; crash → full reservation.
- The max stream duration is strictly below the reservation TTL, validated at startup (ADR-0011).
- Sweepers run on every instance and are off in tests by default (they would claim other test
  files' reservations).

**Tests:** `test/e2e/failurePaths.e2e.test.ts` (disconnect, mid-stream error and drop, Redis down, Postgres down), `test/e2e/crashRecovery.e2e.test.ts` (**a real child process is SIGKILLed mid-stream**; its reservation is swept after the TTL), `test/integration/budgetStore.test.ts` (racing sweepers, skewed clock, orphan index entries), `test/unit/application/ReservationSweeper.test.ts`

**Ask yourself**

1. Your process is `kill -9`ed mid-stream. Show me the exact mechanism that gives the budget back (or charges it), and the test that kills a real process.
2. Two instances sweep at the same moment. Can a reservation be charged twice? Refunded twice?
3. The sweeper charged a reservation; then the "dead" instance comes back and reconciles. What happens?
4. Can a perfectly healthy long stream get swept?
5. Which component writes the ledger row when reconcile fails because Redis blipped?

---

## Day 7: failover and timeouts

**Files:** `src/application/{ModelStreamer,Watchdog}.ts`, the failover loop in `ChatCompletionService.streamReserved`, `src/http/sse/SseWriter.ts` (slow-consumer guard), fake scenarios `status-*`, `hang-headers`, `hang-body`, `midstream-*`

**Decisions and why**

- The commit point is the first real output (non-empty delta or finish). Before it, failover is
  invisible to the client; after it, it's an SSE error event (ADR-0017).
- Retryable = rate_limited / server_error / timeout / connection. Not 400s, not malformed
  streams (not in FR6).
- Timeouts are aborts with a `ProviderError('timeout')` reason, so they're classified like any
  other provider failure. The idle timer is **paused while writing to the client**, so a slow
  client is not provider silence.
- One request deadline across failovers (`MAX_STREAM_DURATION_MS`). Clients that stop reading
  are disconnected after `SSE_WRITE_TIMEOUT_MS`.
- Sink errors are _our_ bugs and must not be classified as provider errors. A test caught this.

**Tests:** `test/unit/application/failover.test.ts` (each retryable kind, non-retryable kinds, order, give-up → 502 + release, no failover after the first byte or after the client left, TTFT, idle, max duration, slow sink ≠ idle), `test/e2e/failover.e2e.test.ts` (over HTTP: 503, 429, never-sends-headers, 400, all-down, stall), `test/unit/http/SseWriter.test.ts`

**Ask yourself**

1. Your primary sends a role-only first chunk and then a 503. Did your client already get a 200?
2. A slow client takes 30 s to read a chunk. Does your idle timeout blame the provider?
3. Does a 400 from the primary fail over? (What does FR6 say?)
4. Is the fallback held to the same `max_tokens` as the primary, under the same reservation?
5. What's your worst-case time to a 502 with 3 candidates?

---

## Day 8: observability and e2e

**Files:** `src/observability/{logger,metrics,metricsServer,InstrumentedProvider,InstrumentedChatCompletion,safeError}.ts`, `src/http/plugins/accessLog.ts`

**Decisions and why**

- Metrics in an injected registry (no prom-client globals), on a separate port (not public).
  Bounded labels only: route templates, providers, enums. Never attempt ids.
- Decorators for provider and chat metrics, so services and adapters are unaware (OCP/DIP).
- `safeError`: third-party error messages are dropped from logs (V8's `JSON.parse` messages quote
  input). Redaction paths are defence in depth, not the main control.
- Fastify's `onRequestAbort` does not fire for hijacked (SSE) replies, so a raw `close`
  listener logs 499s. Found by a test.

**Tests:** `test/e2e/noContentInLogs.e2e.test.ts` (at `trace`, 7 content-bearing paths, sentinels for prompt / completion / system prompt, JWTs and the service key. **Mutation-checked**: it fails when a real leak is injected), `test/e2e/observability.e2e.test.ts`, `test/unit/observability/observability.test.ts`

**Ask yourself**

1. How do you _know_ no prompt text reaches your logs? Does your test fail if you add `log.debug({ last: body.messages.at(-1).content })`?
2. Does every log line of a request carry its id, including lines from inside the streaming loop?
3. Is a client that hangs up mid-stream visible in your access log and metrics?
4. Could your metric labels explode in cardinality (attempt ids, URLs with ids)?

---

## Day 9: shutdown, Docker, CD, load test

**Files:** `src/application/DrainableChatCompletion.ts`, `src/domain/abort.ts`, the shutdown sequence in `src/gateway.ts`, `src/server.ts`, `Dockerfile`, `.dockerignore`, `docker-compose.yml` (profile `app`), `.github/workflows/{ci,cd}.yml`, `scripts/load-test/run.ts`, `docs/LOAD_TEST.md`

**Decisions and why**

- Shutdown order: not ready → stop accepting → drain → abort stragglers with a shared
  `ShutdownAbort` → close connections that went idle during the drain → flush ledger → close
  pools → exit 0 (ADR-0018). Aborted streams settle themselves; nothing is left for the sweeper.
- `close()` would otherwise wait for clients' keep-alive timeouts (measured 5 s). Found by a test.
- One image for the gateway and migrations; non-root; exec-form CMD so node gets SIGTERM;
  a healthcheck with Node's fetch (no curl in slim). `stop_grace_period` > drain timeout.
- The CI docker job boots the production image. A dev-only dependency needed at runtime
  (`node-pg-migrate`) was caught by running the image.
- Load test: baseline vs gateway at the same concurrency; added latency = the difference.

**Tests:** `test/e2e/shutdown.e2e.test.ts` (drain completes; deadline aborts + settles; real SIGTERM on Linux), `test/unit/application/DrainableChatCompletion.test.ts`, manual Docker check (`docker compose stop` mid-stream → `shutting_down` event, exit 0)

**Ask yourself**

1. SIGTERM arrives with 40 streams in flight. Which finish, which are cut, and what is each one charged?
2. After your drain, does `close()` return immediately or wait for keep-alive timeouts?
3. Does your production image actually start? (Is any runtime dependency in devDependencies?)
4. How did you separate the gateway's overhead from the provider's latency in your load numbers?

---

## Day 10: docs and demo

**Files:** `README.md`, `docs/ARCHITECTURE.md` (component + sequence diagrams), `docs/HARDEST_PROBLEM.md` (STAR), `docs/adr/`, `scripts/demo.sh`

**Ask yourself**

1. Could someone run your demo from a clean checkout with only Docker and Node installed?
2. Does each ADR say what you gave up, not just what you chose?
3. Is every "known limitation" something you could defend in an interview?

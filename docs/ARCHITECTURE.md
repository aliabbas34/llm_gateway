# Architecture

How the gateway is built and why. Requirements: [SPEC.md](SPEC.md). Decisions: [adr/](adr/README.md).

## 1. Context

```mermaid
flowchart LR
  student["Student browser<br/>(chat tab)"] -- "POST /v1/chat/completions<br/>Bearer attempt JWT · SSE back" --> gw
  backend["Product backend<br/>(simulated by scripts/)"] -- "mints EdDSA JWT per attempt<br/>(private key)" --> student
  backend -- "POST /v1/attempts/:id/close<br/>Bearer SERVICE_API_KEY" --> gw
  gw["LLM gateway<br/>(this repo, N stateless instances)"]
  gw -- "budgets · status · rate limits ·<br/>reservations (Lua, Redis TIME)" --> redis[(Redis)]
  gw -- "usage ledger (async)" --> pg[(Postgres)]
  gw -- "primary" --> groq["Groq<br/>(OpenAI-compatible SSE)"]
  gw -. "fallback (before 1st byte only)" .-> mistral["Mistral<br/>(OpenAI-compatible SSE)"]
  prom["Prometheus"] -- "scrape :9464/metrics" --> gw
```

The gateway holds only the JWT **public** key and the provider API keys. Students never see
provider keys or choose models. Every instance is identical and stateless; all shared state is in
Redis (authoritative) and Postgres (audit).

## 2. Components and layers

```mermaid
flowchart TB
  subgraph http["http/ (Fastify)"]
    app["buildApp(deps)"] --> plugins["plugins: requestId · accessLog+metrics · cors ·<br/>errorHandler · ipRateLimit · auth · attemptRateLimit · serviceKey"]
    app --> routes["routes: chatCompletions · attempts · health"]
    routes --> sse["sse: SseParser · SseWriter (ChatSink)"]
  end
  subgraph application["application/ (use cases, no I/O libs)"]
    drain["DrainableChatCompletion<br/>(shutdown decorator)"] --> instr["InstrumentedChatCompletion<br/>(metrics decorator, observability/)"]
    instr --> chat["ChatCompletionService<br/>reserve → failover loop → settle → ledger"]
    chat --> streamer["ModelStreamer<br/>(commit point, classification)"] --> wd["Watchdog<br/>(TTFT / idle)"]
    chat --> handle["ReservationHandle<br/>(settle once)"]
    chat --> recorder["UsageRecorder<br/>(async ledger)"]
    sweeper["ReservationSweeper"] ; attempts["AttemptService"] ; health["HealthService"]
  end
  subgraph domain["domain/ (types, errors, ports)"]
    ports["ports: LlmProvider · TokenVerifier · RateLimiter · BudgetStore ·<br/>AttemptStatusStore · UsageLedger · TokenCounter · Clock · IdGenerator · HealthCheck"]
  end
  subgraph infra["infrastructure/ (adapters)"]
    redisA["redis: RedisBudgetStore · RedisRateLimiter ·<br/>RedisAttemptStatusStore · lua/*.lua"]
    pgA["postgres: PgUsageLedger · pool · migrate"]
    prov["providers: OpenAiCompatibleProvider ← Groq, Mistral · FakeProvider · ProviderRegistry"]
    auth["auth: JwtTokenVerifier (jose, EdDSA)"]
    tok["tokenizer: GptTokenCounter (chunked BPE)"]
  end
  routes --> drain
  application --> ports
  infra -. implements .-> ports
  gateway["gateway.ts (composition root)"] --> http & application & infra
  server["server.ts (process: env, signals, listen)"] --> gateway
```

**Dependency rule** (enforced by ESLint `no-restricted-imports`): `domain` ← `application` ←
`infrastructure` / `http` / `observability` ← `gateway.ts` ← `server.ts`. The core never imports
Fastify, ioredis, pg, jose, pino or prom-client.

| SOLID | where it shows                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SRP   | the route handler only builds the sink and calls the use case; streaming one model (`ModelStreamer`), timeouts (`Watchdog`), settle-once (`ReservationHandle`), ledger I/O (`UsageRecorder`) are separate |
| OCP   | a new vendor = an adapter subclass + one `ProviderRegistry` factory line; metrics and shutdown added as decorators without touching the service                                                           |
| LSP   | one contract suite (`test/contract/providerContract.ts`) runs against every adapter, including the fake, with identical error classification                                                              |
| ISP   | each Redis store implements one small port; there is no "RedisService"                                                                                                                                    |
| DIP   | `application` depends on `domain/ports.ts`; `buildApp(deps)` and `createGateway()` inject implementations; tests inject in-memory fakes                                                                   |

## 3. Request pipeline

| #   | step                                                    | where                                                    | rejects with                            |
| --- | ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| 1   | request id (server-generated, ADR-0014)                 | `genReqId` + `requestId` hook                            | —                                       |
| 2   | per-IP rate limit (GCRA)                                | `onRequest` (chat scope)                                 | 429 + Retry-After                       |
| 3   | auth: EdDSA signature, `aud`, `exp`, claim shapes       | `onRequest`                                              | 401                                     |
| 4   | validation: ≤ 256 KB, ≤ 100 msgs, ≤ 32 000 chars, roles | Fastify `bodyLimit` + zod schema                         | 400                                     |
| 5   | per-attempt rate limit (GCRA)                           | `preHandler`                                             | 429 + Retry-After                       |
| 6   | reserve (Lua)                                           | first I/O of `ChatCompletionService.complete` (ADR-0004) | 403 closed / 403 budget_exhausted / 503 |
| 7   | stream with failover, reconcile, ledger                 | `ChatCompletionService`                                  | 502 before first byte / SSE error after |

The pairwise ordering is tested in `test/unit/http/pipeline.test.ts`.

## 4. Happy path

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant G as Gateway
  participant R as Redis
  participant P as Groq
  participant DB as Postgres
  B->>G: POST /v1/chat/completions (Bearer JWT, messages)
  G->>R: GCRA ip limit (Lua)
  G->>G: verify JWT (public key) · validate body
  G->>R: GCRA attempt limit (Lua)
  G->>G: drop client system msgs, prepend system prompt, count input tokens
  G->>R: ZADD gw:resv:expiry (index first, ADR-0005)
  G->>R: reserve.lua — closed? · SETNX budget · effective=min(cap, remaining−input) · DECRBY · HSET resv
  R-->>G: reserved = input + effective
  G->>P: POST /chat/completions stream=true, max_tokens=effective
  P-->>G: first chunk (no bytes sent to the browser before this)
  G-->>B: 200 text/event-stream + first delta (commit point)
  loop each chunk
    P-->>G: data: {delta}
    G-->>B: data: chat.completion.chunk
  end
  P-->>G: usage chunk + [DONE]
  G->>R: settle.lua — charge min(actual, reserved), refund rest, HDEL (idempotent)
  G-->>B: usage chunk + data: [DONE]
  G--)DB: batched multi-row INSERT usage_ledger … ON CONFLICT DO NOTHING (async, ≤ 50 ms)
```

## 5. Failover (FR6, ADR-0017)

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant G as Gateway
  participant P1 as Groq (primary)
  participant P2 as Mistral (fallback)
  Note over G: reservation already held (one per request, shared by all candidates)
  G->>P1: stream request (Watchdog: TTFT timer armed)
  alt 429 / 5xx / connection error / TTFT timeout
    P1-->>G: ProviderError (retryable)
    Note over B,G: nothing sent to the browser yet, so the failover is invisible
    G->>P2: same request, same max_tokens
    P2-->>G: first chunk
    G-->>B: 200 + stream (failover_count = 1)
  else 4xx (not 429) / malformed stream
    P1-->>G: ProviderError (not retryable)
    G->>G: release reservation (charge 0), ledger upstream_error
    G-->>B: 502 JSON {error: upstream_unavailable}
  end
  opt failure AFTER the first byte (error event, idle timeout, dropped connection)
    P1-->>G: error mid-stream
    G->>G: reconcile input + streamed tokens
    G-->>B: event: error {upstream_error | upstream_timeout}, then close (no [DONE])
  end
```

## 6. Budget: reserve, reconcile, and crash recovery

```mermaid
sequenceDiagram
  autonumber
  participant G1 as Gateway A
  participant R as Redis
  participant G2 as Gateway B (sweeper)
  participant DB as Postgres
  G1->>R: ZADD expiry index (provisional score)
  G1->>R: reserve.lua (expiresAt = Redis TIME + TTL)
  alt normal end / client disconnect / mid-stream error / shutdown abort
    G1->>R: settle.lua (actual = provider usage or input + streamed estimate)
    R-->>G1: settled {charged ≤ reserved}
    G1--)DB: ledger row (completed / client_disconnected / stream_error / shutdown_aborted)
  else provider failed before first byte
    G1->>R: settle.lua with actual = 0 (release)
    G1--)DB: ledger row upstream_error, charged 0
  else Gateway A crashes (SIGKILL, OOM)
    Note over G1: no settle ever arrives
    loop every SWEEPER_INTERVAL_MS, on every instance
      G2->>R: ZRANGEBYSCORE expiry ≤ Redis TIME
      G2->>R: claim_expired.lua (HGET → expired per Redis TIME? → HDEL)
      R-->>G2: claimed (charged in full) · not_expired (re-score) · already_settled (drop)
    end
    G2--)DB: ledger row expired_unreconciled (charged = reserved)
  end
```

**Invariant**: `remaining + Σ open reservations + Σ charged = initial budget`, and `remaining ≥ 0`
at every instant. Three things guarantee it:

- reserve subtracts only what it has checked is available, atomically in Lua;
- settle and claim each delete the reservation in the same atomic step as the refund or charge,
  so each reservation is settled exactly once;
- the provider is called with `max_tokens = effective`.

Proven by `test/concurrency/` (100 parallel reserves, a 200-operation seeded storm with a live
sampler, 60 parallel HTTP chats on one attempt).

## 7. Redis data model

| key                    | type   | content                                                                                      |
| ---------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `gw:{att:<id>}:budget` | string | remaining tokens (after open reservations)                                                   |
| `gw:{att:<id>}:status` | string | `closed` or absent                                                                           |
| `gw:{att:<id>}:resv`   | hash   | reservationId → JSON `{r reserved, i input, e expiresAt, c createdAt, s student, q request}` |
| `gw:{att:<id>}:rl`     | string | GCRA theoretical arrival time (per attempt)                                                  |
| `gw:rl:ip:<ip>`        | string | GCRA theoretical arrival time (per IP)                                                       |
| `gw:resv:expiry`       | zset   | member = attempt id and reservation id joined by a pipe; score = provisional expiry          |

The `{att:<id>}` hash tag puts an attempt's keys in one cluster slot, so a per-attempt Lua script is
cluster-safe. Every cross-instance time decision uses Redis `TIME` (ADR-0003). Redis must run with
`noeviction` and AOF (ADR-0016): an evicted budget would be re-initialised as a fresh allowance.

## 8. Error taxonomy

| class                        | status | code                   | when                                                    |
| ---------------------------- | ------ | ---------------------- | ------------------------------------------------------- |
| `ValidationError`            | 400    | `invalid_request`      | schema, body size, malformed JSON, only-system messages |
| `UnauthorizedError`          | 401    | `unauthorized`         | missing/invalid/expired JWT, bad service key            |
| `AttemptClosedError`         | 403    | `attempt_closed`       | reserve on a closed attempt                             |
| `BudgetExhaustedError`       | 403    | `budget_exhausted`     | effective completion ≤ minimum (ADR-0006)               |
| `RateLimitedError`           | 429    | `rate_limited`         | GCRA limit, with Retry-After                            |
| `UpstreamUnavailableError`   | 502    | `upstream_unavailable` | no candidate produced output                            |
| `DependencyUnavailableError` | 503    | `service_unavailable`  | Redis down (fail closed), Retry-After                   |
| `ShuttingDownError`          | 503    | `shutting_down`        | draining instance, Retry-After                          |
| anything else                | 500    | `internal_error`       | a bug (full error logged)                               |

Clients always get `{error: {code, message}, request_id}` with a generic message. Details go to
the logs, correlated by `request_id`. Provider failures are a separate internal taxonomy
(`ProviderError.kind`) that drives failover; it never reaches clients directly.

## 9. Observability

- **Logs**: pino JSON, one line per event, `request_id` on every request-scoped line,
  `attempt_id` after auth. Access log per request (499 for client aborts, including hijacked
  SSE). `chat completion finished` with outcome, provider, tokens, TTFT, latency and failovers.
  **Never content**: no code path logs bodies; error summaries drop third-party messages
  (`safeError`); redaction paths are a second line of defence; an e2e test greps every log line
  for prompt and completion sentinels.
- **Metrics** (`:9464/metrics`, not on the public port): HTTP requests/duration by route
  template, chat outcomes, active streams, TTFT histogram, tokens charged, failovers by reason,
  provider requests by result and first-chunk latency, ledger write failures, sweeper claims and
  errors, process metrics and event-loop lag.

## 10. Deployment shape

- One image (`Dockerfile`, multi-stage, non-root, healthcheck) runs both the gateway and
  migrations (`node dist/migrate.js`).
- Horizontally scalable: no instance-local state except in-flight streams.
- Orchestrator: readiness = `/readyz`, liveness = `/healthz`, termination grace >
  `SHUTDOWN_DRAIN_TIMEOUT_MS`, `/metrics` on an internal port.
- CI (`.github/workflows/ci.yml`): lint → format → typecheck → build → all tests with coverage
  against service containers, plus a production-image smoke job. CD (`cd.yml`): build + push to
  GHCR, Trivy scan, deploy **stubbed**.

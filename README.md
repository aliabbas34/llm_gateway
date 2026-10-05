# LLM Gateway

A production-quality reference implementation of a **token-budgeted, streaming LLM gateway** for an
AI-interview practice platform. Each interview attempt gets a fixed token allowance; the browser
talks to the gateway directly with a short-lived attempt JWT. The gateway streams
OpenAI-compatible SSE from Groq, fails over to Mistral before the first byte, and enforces the
budget as a **hard limit**, including under concurrency, disconnects and crashes.

- **Spec:** [docs/SPEC.md](docs/SPEC.md)
- **Plan and progress:** [docs/PLAN.md](docs/PLAN.md)
- **Architecture** (with diagrams): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Decisions:** [docs/adr/](docs/adr/README.md)
- **Hardest problem** (STAR): [docs/HARDEST_PROBLEM.md](docs/HARDEST_PROBLEM.md)
- **Load test:** [docs/LOAD_TEST.md](docs/LOAD_TEST.md)
- **Comparing your own version:** [docs/COMPARISON_GUIDE.md](docs/COMPARISON_GUIDE.md)

## Features

|               |                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API           | `POST /v1/chat/completions` (OpenAI request shape, OpenAI-format SSE), `POST /v1/attempts/:id/close`, `/healthz`, `/readyz`, `/metrics` (port 9464)                                                |
| Auth          | EdDSA (Ed25519) JWT per attempt, public key only; `aud`, `exp`, claim schema. Service key for close (constant-time compare).                                                                       |
| Trust         | The client sends only `messages`; its `model` and `max_tokens` are ignored; system messages are dropped; the configured system prompt is prepended.                                                |
| Limits        | 256 KB body, 100 messages, 32 000 chars per message; GCRA rate limits per IP (before auth) and per attempt (after auth) in Redis.                                                                  |
| Budget        | Atomic Lua reserve (worst case) → provider capped at `max_tokens = effective` → reconcile `min(actual, reserved)`, idempotent. Crash recovery via an expiry index and a sweeper on every instance. |
| Providers     | Groq (primary), Mistral (fallback), fake (tests, demo, load). Raw `fetch` over a dedicated undici pool, one contract test suite for all adapters.                                                  |
| Failover      | Only before the first byte, only on 429 / 5xx / timeout / connection. After the first byte: SSE `error` event. TTFT, idle and max-duration timeouts.                                               |
| Reliability   | Fails closed on Redis failure (503 + Retry-After); keeps serving when Postgres is down; graceful shutdown drains, then aborts and settles every stream.                                            |
| Observability | pino JSON logs with request ids (never prompt or completion text, proven by a test); Prometheus metrics, including the gateway's own added latency.                                                |

## Quick start (local)

Prerequisites: **Node 22.19+**, **Docker** (for Redis and Postgres). Run from the repo root.

```bash
npm ci
```

```bash
docker compose up -d --wait
```

```bash
cp .env.example .env
```

```bash
npm run gen-keys
```

Paste the printed `JWT_PUBLIC_KEY=…` line into `.env`, and set `SERVICE_API_KEY` to 32+ random
characters (`openssl rand -hex 32`). Then:

```bash
npm run migrate
```

**Without provider keys** (fake provider). In one terminal:

```bash
npm run fake-provider
```

In another terminal, with `FAKE_PROVIDER_BASE_URL=http://localhost:8090/v1`,
`PRIMARY_MODEL=fake:ok?words=40&gap=25` and `FALLBACK_MODELS=` set in `.env`:

```bash
npm run dev
```

**With real providers:** set `GROQ_API_KEY` and `MISTRAL_API_KEY` in `.env` (keep the default
`PRIMARY_MODEL` / `FALLBACK_MODELS`). Opt out of training on your data in the Mistral console
first (ADR-0002). Then run `npm run dev`.

Mint a token, as the product backend would:

```bash
TOKEN=$(npm run -s mint-token -- --attempt att-1 --student stu-1 --budget 20000 --cap 1024)
```

Stream a chat:

```bash
curl -N http://localhost:8080/v1/chat/completions -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"Explain what a JWT is in one sentence."}]}'
```

Close the attempt (later requests get `403 attempt_closed`):

```bash
npm run close-attempt -- --attempt att-1
```

Full walkthrough: streamed chat → ledger row → failover → budget exhaustion → close → metrics.

```bash
bash scripts/demo.sh
```

Whole stack in containers (gateway + fake provider + migrations):

```bash
docker compose --profile app up -d --build --wait
```

## Scripts

| script                                                                  | what it does                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev` / `build` / `start`                                       | run from source (tsx, loads `.env`) / compile to `dist/` / run `dist/server.js`                  |
| `npm run lint` · `format:check` · `typecheck`                           | ESLint (strict, type-checked) · Prettier · `tsc --noEmit`                                        |
| `npm test`                                                              | every test project: unit, contract, integration, concurrency, e2e (needs `docker compose up -d`) |
| `npm run test:unit` · `test:integration` · `test:e2e` · `test:coverage` | subsets / with coverage (≥ 85 % enforced on `src/domain` and `src/application`)                  |
| `npm run check`                                                         | lint + format + typecheck + all tests with coverage: what CI runs                                |
| `npm run migrate`                                                       | apply SQL migrations (`node dist/migrate.js` in the container)                                   |
| `npm run gen-keys` · `mint-token` · `close-attempt`                     | simulated product backend                                                                        |
| `npm run fake-provider`                                                 | OpenAI-compatible fake upstream with misbehaviour scenarios                                      |
| `npm run load-test`                                                     | 100/250/500-connection load test + 500 concurrent streams (needs `npm run build`)                |

## Project layout

```
src/
  config/          loadConfig + zod schema (every env var documented in schema.ts)
  domain/          types, error taxonomy, provider errors, ports (interfaces)
  application/     ChatCompletionService, ModelStreamer, Watchdog, ReservationHandle,
                   UsageRecorder, ReservationSweeper, DrainableChatCompletion, AttemptService, HealthService
  infrastructure/  redis/ (stores + lua/), postgres/, providers/, auth/, tokenizer/, system/
  http/            buildApp, routes/, plugins/, schemas/, sse/
  observability/   logger, metrics, metrics server, decorators, safeError
  gateway.ts       composition root          server.ts   process entry (env, signals, listen)
scripts/           gen-keys, mint-token, close-attempt, fake-provider-server, demo.sh, load-test/
migrations/        plain SQL (node-pg-migrate)
test/              unit/ contract/ integration/ concurrency/ e2e/ helpers/
docs/              SPEC, PLAN, ARCHITECTURE, HARDEST_PROBLEM, LOAD_TEST, COMPARISON_GUIDE, adr/
```

## Configuration

Every variable, its default and its validation are in [src/config/schema.ts](src/config/schema.ts),
with a commented template in [.env.example](.env.example). Required: `REDIS_URL`, `DATABASE_URL`,
`JWT_PUBLIC_KEY`, `SERVICE_API_KEY`, plus a key (or URL) for every provider named in
`PRIMARY_MODEL` / `FALLBACK_MODELS`. Startup fails fast with the variable's name, never its value.

Operational requirements: Redis with `maxmemory-policy noeviction` and persistence (ADR-0016);
orchestrator termination grace > `SHUTDOWN_DRAIN_TIMEOUT_MS` (ADR-0018); `/metrics` exposed only
on the internal network.

## Known limitations

- **Ledger durability:** rows written while Postgres is down are lost (logged and counted); there
  is no outbox in v1 (ADR-0010). Budget enforcement is unaffected.
- **Crash charging:** a crashed instance's in-flight reservations are charged in full after the
  TTL (default 6 min), which can over-charge by the unused tail (ADR-0005/0011).
- **Redis durability:** AOF `everysec` can lose ≤ 1 s of budget writes on a hard Redis crash (ADR-0016).
- **Token estimates:** the input estimate uses o200k BPE, not the providers' tokenizers. This
  doesn't affect the hard limit, but `budget_exhausted` can arrive slightly early (ADR-0008).
- **Tokenizer CPU:** a maximal adversarial body still costs ~0.1 s of CPU (linear, bounded by
  the body limit and rate limits).
- **Free fallback tier:** Mistral's free plan has low rate limits. It absorbs Groq incidents, not
  sustained full traffic (ADR-0002).
- **Token lifetime:** `exp` is enforced, but a maximum token lifetime is not; the backend is
  trusted to mint short-lived tokens.
- **Load numbers:** measured on a 4-thread laptop with everything on one machine; see
  [docs/LOAD_TEST.md](docs/LOAD_TEST.md) for what that does and doesn't show.
- **Dev-only advisory:** `npm audit` reports a moderate advisory in a dev-only dependency
  (autocannon → hyperid → uuid). Production dependencies audit clean (`npm audit --omit=dev`).

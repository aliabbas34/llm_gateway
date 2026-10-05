# LLM Gateway — Specification v1

> Status: **frozen**. Disagreements are recorded as ADRs (`docs/adr/`) or in
> "Open questions" at the bottom. They do not edit the requirements.

## 1. Product context

The product is an AI-interview practice platform. Each **attempt** gives a
student a codebase and an AI chat tab with a fixed **token allowance**. When the
allowance runs out, the chat stops.

This repository is **only the gateway**. The product backend (which creates
attempts and mints tokens) is simulated by dev scripts in `scripts/`.

## 2. Architecture

```
browser ──(JWT per attempt)──▶ gateway ──▶ Groq (primary)
                                  │   └──▶ second free OpenAI-compatible vendor (fallback)
                                  ├──▶ Redis   (budgets, attempt status, rate limits, reservations)
                                  └──▶ Postgres (usage ledger)
product backend ──(service key)──▶ gateway  (close attempt)
```

- The browser calls the gateway directly.
- The backend issues a short-lived **EdDSA-signed JWT** per attempt. The gateway
  holds only the **public key**.
- Providers: **Groq** (primary), a **second free OpenAI-compatible provider on a
  different vendor** (fallback; the choice and its free tier are verified and
  recorded in an ADR), and a **fake provider** for tests.

## 3. Trust model

JWT claims:

| claim            | meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `sub`            | student id                                                                    |
| `attempt_id`     | attempt id                                                                    |
| `aud`            | must equal `"llm-gateway"`                                                    |
| `exp`            | expiry (short-lived)                                                          |
| `max_tokens_cap` | upper bound on completion tokens per request                                  |
| `token_budget`   | initial allowance; written to Redis **only if the attempt has no budget yet** |

- Models are **not** in the token. Primary model and `fallback_models` come from
  gateway config.
- Remaining budget and attempt status live in **Redis** (source of truth).
- The client sends only `messages`. The gateway **ignores** client `model` and
  `max_tokens`, accepts only `user` / `assistant` roles, **drops** `system`
  messages, and **prepends the configured system prompt**.

## 4. Functional requirements

| id  | requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1 | `POST /v1/chat/completions`: OpenAI-compatible request, OpenAI-format SSE response.                                                                                                                                                                                                                                                                                                                                                                            |
| FR2 | Auth: verify signature, `aud`, `exp`. Closed attempt → **403**. Bad / missing / expired token → **401**.                                                                                                                                                                                                                                                                                                                                                       |
| FR3 | Validation **before** token counting: body ≤ 256 KB, ≤ 100 messages, each message ≤ 32,000 chars → **400**.                                                                                                                                                                                                                                                                                                                                                    |
| FR4 | Redis rate limits: per **IP before auth**, per **attempt after auth** (requests/minute) → **429 + Retry-After**.                                                                                                                                                                                                                                                                                                                                               |
| FR5 | Token budget via an **atomic Lua reserve**: status check → `SETNX` init from `token_budget` → `effective = min(max_tokens_cap, remaining − input)` → reject `budget_exhausted` if `effective ≤` a minimum useful threshold → reserve `input + effective` → record the reservation with an expiry. **Reconcile** on stream end: charge `min(actual, reserved)`, refund the rest, **idempotent**. The budget is **never exceeded**, including under concurrency. |
| FR6 | Failover **only before the first byte** reaches the client, **only** to `fallback_models`, on 429 / 5xx / timeout / connection error. After the first byte: SSE error event, then close.                                                                                                                                                                                                                                                                       |
| FR7 | `POST /v1/attempts/:id/close` with a **service key** (constant-time compare). The gateway writes `closed` to Redis; running streams finish; new requests → 403. **Idempotent.**                                                                                                                                                                                                                                                                                |
| FR8 | Postgres usage ledger, one row per request: `request_id` (unique), `attempt_id`, `student`, `model`, `provider`, input/output tokens, reserved tokens, `outcome` (enum), latency ms, TTFT ms, failover count, `created_at`.                                                                                                                                                                                                                                    |
| FR9 | `/healthz` (process alive), `/readyz` (Redis + Postgres reachable; **fails during shutdown**).                                                                                                                                                                                                                                                                                                                                                                 |

## 5. Non-functional requirements

| id   | requirement                                                           |
| ---- | --------------------------------------------------------------------- |
| NFR1 | 500 concurrent streams per instance.                                  |
| NFR2 | Stateless; horizontally scalable.                                     |
| NFR3 | ≤ 50 ms p95 added latency before the first token.                     |
| NFR4 | Budget is a **hard** limit.                                           |
| NFR5 | **Fail closed** on Redis failure: 503 + Retry-After; `/readyz` fails. |
| NFR6 | Provider keys are server-side only.                                   |
| NFR7 | CORS allowlist.                                                       |
| NFR8 | Structured JSON logs carrying a request ID.                           |
| NFR9 | **Never** log prompt or completion text.                              |

## 6. Out of scope

UI, admin, more than 2 real providers, caching, chat history, per-problem
prompts, the product backend, resumable streams.

## 7. Baseline decisions

- Raw `fetch` (no provider SDKs).
- Cancel the upstream on client disconnect (`reply.raw` `'close'` +
  `writableFinished`); cancel unused response bodies.
- `app.ts` (`buildApp(deps)`) is separate from `server.ts`.
- `loadConfig()` validates with zod; no import-time side effects.
- Status semantics: 400 / 401 / 403 / 429 / 502 / 503; **500 only for real bugs**.
- Generic error bodies to clients; details go to logs.
- No resumable streams in v1.

## 8. Open questions

Recorded and resolved (safest option) in ADRs as they come up; see
`docs/adr/README.md` for the index.

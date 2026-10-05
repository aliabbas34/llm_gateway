# ADR-0006: Budget exhausted → 403 `budget_exhausted`, not 429

- Status: accepted
- Date: 2026-10-03

## Context

FR5 rejects a request when the completion that still fits is at or below a minimum useful size,
but it doesn't fix the status code. The spec's vocabulary is 400/401/403/429/502/503. OpenAI's
own API uses 429 `insufficient_quota`, and many clients retry 429s automatically with backoff.

## Decision

`BudgetExhaustedError` → **403** with code `budget_exhausted` and no `Retry-After`.

## Consequences

- Clients and SDKs that auto-retry 429s won't hammer the gateway for an allowance that is never
  coming back. The attempt's allowance is fixed; only the product backend could change it, by
  starting a new attempt.
- One edge case: while other requests of the same attempt still hold reservations, their refunds
  may free enough budget a moment later. We accept answering 403 then rather than inviting
  blind retries. A student who sends another message after the stream ends gets a fresh
  decision.
- 403 is shared with `attempt_closed`; the `code` field tells them apart, and both mean "this
  attempt can't chat any more" from the UI's point of view.

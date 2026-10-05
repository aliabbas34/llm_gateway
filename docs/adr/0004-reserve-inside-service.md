# ADR-0004: "Reserve" runs inside the service's try/finally, not as a Fastify hook

- Status: accepted
- Date: 2026-10-03

## Context

The required pipeline is `requestId → IP rate limit → auth → validation → attempt rate limit →
reserve → handler`, and every reservation must end in reconcile or release. A `preHandler` hook
could reserve and stash a handle on the request, but then the code that _settles_ it would live
elsewhere (`onResponse`, `onRequestAbort`, `onError` hooks, a hijacked reply that skips some of
them). Each of those is a way to leak a reservation.

## Decision

Steps 1–5 are Fastify hooks. Steps 6 (reserve) and 7 (stream) are the first statements of
`ChatCompletionService.complete()`:

```ts
const reservation = await this.reserve(...);        // step 6 (rejections → 403 + ledger row)
try {
  return await this.streamReserved(..., reservation, ...);  // step 7: explicit reconcile/release
} finally {
  if (!reservation.settled) await reservation.release();   // safety net for anything unexpected
}
```

`ReservationHandle` settles at most once (a second reconcile/release returns the first result),
so the explicit settle and the safety net can never double-apply.

## Consequences

- One lexical scope owns the reservation from birth to settlement. The question "where does your
  reservation get released if the handler throws?" has a one-line answer.
- The route handler stays free of business logic (SRP): it only builds the sink and calls the service.
- Pipeline order is still observable and tested (`test/unit/http/pipeline.test.ts`); reserve is
  simply the first I/O of the handler step.
- If the settle itself fails (Redis down at the very end), the finally can't fix it; the
  reservation expires and the sweeper settles it (ADR-0005).

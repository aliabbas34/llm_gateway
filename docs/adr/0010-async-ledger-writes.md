# ADR-0010: Ledger writes are asynchronous and best-effort (no outbox in v1)

- Status: accepted
- Date: 2026-10-03

## Context

FR8 wants one ledger row per request. The failure-path list says: _Postgres down → stream
still served, ledger failure logged + metric, readyz fails_. The budget (the thing that must be
exact) lives in Redis; the ledger is an audit and analytics trail.

## Decision

- `UsageRecorder.record(entry)` starts the INSERT and returns immediately. The request never
  awaits Postgres. A failure calls `onFailure` (error log with ids only, plus the
  `ledger_write_failures_total` metric from P8).
- Inserts use `ON CONFLICT (request_id) DO NOTHING`, so a duplicate write is harmless.
- **Batched** (amended 2026-10-03, P9): rows are buffered for ≤ 50 ms (or until 200 are
  queued) and written with one multi-row INSERT. Found by the demo: the sweeper claimed ~470
  stranded reservations at once; one INSERT per row exhausted the pg pool's 2 s acquire timeout,
  so the rows were lost. Now a 1 000-row burst through a 2-connection pool is an integration test.
- Pending writes are tracked; graceful shutdown calls `flush()` before closing the pool.
- Row ownership: whoever settles the reservation writes the row (ADR-0005). Rejections
  (budget_exhausted, attempt_closed) write a row with zero reserved/charged.

## Consequences

- Postgres latency and outages never affect TTFT or availability.
- If Postgres is down, rows for that period are **lost** (visible in logs/metrics). Budget
  enforcement is unaffected, because Redis is the source of truth.
- A future outbox (append to a Redis stream, drain to Postgres) would make the ledger durable
  through Postgres outages; deferred (YAGNI for v1, listed in known limitations).

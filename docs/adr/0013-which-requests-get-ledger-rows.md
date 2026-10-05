# ADR-0013: Which requests get a ledger row

- Status: accepted
- Date: 2026-10-03

## Context

FR8 says "one row per request". Some requests never identify a student or attempt (401), never
reach the budget (400, 429), or fail on infrastructure (503 when Redis is down). A row needs
`attempt_id` and `student_id`, which are NOT NULL.

## Decision

A row is written for every request that **reaches the reserve step**:

| outcome                | when                                         | reserved / charged                            |
| ---------------------- | -------------------------------------------- | --------------------------------------------- |
| `completed`            | stream finished                              | reserved / min(actual, reserved)              |
| `client_disconnected`  | client left                                  | reserved / input + streamed estimate (capped) |
| `stream_error`         | provider failed after the first byte         | reserved / input + streamed estimate (capped) |
| `upstream_error`       | every candidate failed before the first byte | reserved / 0                                  |
| `budget_exhausted`     | reserve rejected                             | 0 / 0                                         |
| `attempt_closed`       | reserve rejected                             | 0 / 0                                         |
| `shutdown_aborted`     | aborted at the drain deadline (P9)           | reserved / estimate                           |
| `expired_unreconciled` | swept after a crash                          | reserved / reserved                           |

Requests rejected _before_ reserve (400 / 401 / 429 / 503) are visible in the access log and in
metrics, but not in the ledger.

## Consequences

- The ledger answers "how did this attempt's allowance get spent?" completely, including refusals.
- Unauthenticated noise (bots, expired tabs) doesn't bloat the ledger.
- A 503 at reserve time (Redis down) has no row; there was no reservation to account for.

# ADR-0011: Maximum stream duration is strictly below the reservation TTL

- Status: accepted
- Date: 2026-10-03

## Context

The sweeper charges any reservation older than its TTL, assuming the owner is dead. If a
_healthy_ stream ran longer than the TTL, the sweeper would claim it mid-flight: it would be
charged in full, and its own reconcile would become a no-op. That's correct for the budget but
wrong for the student, and it produces a misleading `expired_unreconciled` ledger row.

## Decision

- `MAX_STREAM_DURATION_MS` (default 300 s) is a hard cap on one stream. The stream is aborted
  and settled at that point (enforced with the timeouts in P7).
- Config validation refuses to start unless
  `RESERVATION_TTL_MS ≥ MAX_STREAM_DURATION_MS + 5 s`. The defaults (360 s vs 300 s) leave 60 s.
  The margin only has to cover settle latency and Redis/host clock skew, both measured in
  milliseconds (skew measured at ~2 ms against the compose Redis). A small hard minimum keeps
  crash-recovery tests fast.
- The graceful-shutdown drain deadline is also far below the TTL (25 s by default).

## Consequences

- A live, healthy stream can never be swept.
- Crash recovery takes up to TTL + sweep interval (~6 min by default) before a dead instance's
  reservations return to the pool. During that window the student's remaining budget is
  temporarily lower than it should be. Acceptable, and documented.

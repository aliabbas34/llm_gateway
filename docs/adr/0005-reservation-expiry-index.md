# ADR-0005: Reservation expiry index — written before the reservation, claimed atomically

- Status: accepted
- Date: 2026-10-03

## Context

A gateway can die between reserve and reconcile (crash, OOM kill, deploy without drain). Its
reservation would then hold budget forever. Per-attempt state lives in hash-tagged keys
(`gw:{att:<id>}:*`, one cluster slot per attempt), but a sweeper needs a **global** view of
expiring reservations: the zset `gw:resv:expiry`, which lives in its own slot. Redis Cluster can't
touch both slots in one script, so "reserve + index" can't be atomic.

## Decision

1. **Index before data.** `RedisBudgetStore.reserve` first `ZADD`s `attemptId|reservationId` with a
   _provisional_ score (local clock + TTL), and only then runs `reserve.lua`.
   - Crash after ZADD, before reserve: an orphan index entry; the sweeper finds no reservation
     (`already_settled`) and removes it. Harmless.
   - The opposite order could leave a reservation with no index entry, invisible to every
     sweeper. That's a permanent budget leak. Rejected.
2. **Authoritative expiry lives with the data.** `reserve.lua` stores `expiresAt = Redis TIME +
TTL` in the reservation (JSON in the per-attempt hash). The zset score is only a hint
   (ADR-0003).
3. **Claim atomically per attempt.** `claim_expired.lua` does HGET → check expiry against Redis
   `TIME` → HDEL in one script. Outcomes:
   - `claimed`: charged in full (nothing refunded); the sweeper writes the ledger row
     `expired_unreconciled`.
   - `not_expired` (provisional score was early because of clock skew): re-score with the real expiry.
   - `already_settled`: the request reconciled in time, or another sweeper won; just drop the
     index entry.
4. Every instance runs the sweeper; correctness doesn't depend on there being exactly one.

## Consequences

- At most one party settles each reservation: the request (reconcile/release), or exactly one
  sweeper. A late reconcile after a claim is a no-op, so no double refund or double charge.
- "Whoever settles writes the ledger row": the request writes its row only if _its_ settle
  returned `settled`, so the ledger never gets two conflicting rows for one request.
- Full charge on expiry is conservative: the student may lose up to `reserved − actual` tokens
  when the gateway crashed mid-stream. That's the price of never exceeding the budget.
- Tested: crash orphan, clock-skewed provisional score, two sweepers racing
  (`test/integration/budgetStore.test.ts`).

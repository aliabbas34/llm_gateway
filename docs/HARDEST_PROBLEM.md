# The hardest problem: a token budget that is a hard limit, across concurrency, failover, disconnects and crashes

STAR format.

## Situation

Each interview attempt has a fixed token allowance. The chat must stop when it runs out, and
the spec says the budget is a **hard** limit (NFR4), "including under concurrency" (FR5). Four
things make that difficult at once:

1. **You don't know the cost when you start.** Output length is unknown until the stream ends,
   and the input is only an _estimate_ (the gateway tokenizer differs from Groq's and Mistral's).
2. **Concurrency on one attempt.** A student can open several tabs or retry. N instances behind
   a load balancer can each be streaming for the same attempt at the same moment.
3. **Streams end in many ways.** Completed; client closed the tab; provider died mid-stream;
   provider failed before the first byte and we failed over; timeouts; graceful shutdown; and
   the gateway process itself can be SIGKILLed with money (tokens) in flight.
4. **No shared memory.** Instances are stateless; everything must go through Redis, whose
   clock is not the instances' clock, and in Redis Cluster a script may only touch one slot.

A naive "read remaining → call provider → subtract usage" loses on every one of these:
check-then-act races overspend, a crash between call and subtract under-counts forever, and a
disconnect leaves the subtraction to code that never runs.

## Task

Design accounting where, **for every possible interleaving and failure**:

- the sum charged to an attempt never exceeds its initial budget, and the remaining budget never
  goes negative;
- every reservation ends exactly once, by reconcile, release, or the sweeper, so budget is neither
  leaked (held forever) nor double-refunded;
- the ledger shows one row per request that agrees with Redis;
- the hot path adds a few milliseconds at most (NFR3: ≤ 50 ms p95 before the first token).

## Action

1. **Reserve the worst case up front, atomically.** `reserve.lua` runs in Redis as one atomic
   step: closed check → `SET NX` initial budget (a later token can't top it up) →
   `effective = min(max_tokens_cap, remaining − input)` → reject if `effective ≤ 16` → `DECRBY
input + effective` → record the reservation. Concurrent requests are serialised by Redis
   itself; there is no read-modify-write in application code.
2. **Make the reservation binding on the provider.** The provider is called with
   `max_tokens = effective`. It can't produce more than was reserved, so the hard limit doesn't
   depend on our tokenizer being accurate.
3. **Settle with min(actual, reserved), exactly once.** `settle.lua` deletes the reservation in
   the same atomic step as the refund. A second settle (a retry, a race with the sweeper) finds
   nothing and is a no-op. On the application side, `ReservationHandle` memoises the first
   settle, and one `try/finally` in `ChatCompletionService` owns the handle from reserve to
   settle (ADR-0004), so even a bug that throws mid-stream releases the budget.
4. **A charge rule for every way a stream ends** (ADR-0013):
   - completed → provider usage;
   - disconnect, mid-stream error or shutdown → input + tokens actually streamed, counted locally;
   - failed before the first byte → 0, and failover reuses the same reservation;
   - crashed → full reservation.
5. **Crash recovery that is safe across instances** (ADR-0005). The global expiry index can't
   live in the attempt's slot, so it is written _before_ the reservation: a crash in between
   leaves a harmless orphan, never an unindexed reservation. Every instance runs a sweeper; its
   claim is atomic per attempt (HGET → expired per **Redis `TIME`** → HDEL), so two sweepers
   never both claim, and a late reconcile becomes a no-op. A provisional index score from a
   skewed local clock is corrected, never trusted (ADR-0003).
6. **Never sweep a live stream** (ADR-0011): the max stream duration is enforced, and config
   validation refuses `RESERVATION_TTL < MAX_STREAM_DURATION + 5 s`.
7. **One owner per ledger row.** Whoever settles writes the row: the request if _its_ settle
   returned `settled`, otherwise the sweeper (`expired_unreconciled`). There are never two
   conflicting rows; `ON CONFLICT (request_id) DO NOTHING` makes retries harmless. Postgres
   enforces `charged ≤ reserved` again as a CHECK constraint.

## Result

- **Proven under concurrency, not just argued:**
  - 100 parallel reserves on one attempt;
  - a 200-operation seeded storm mixing reserves, reconciles above the reservation, releases
    and duplicate settles, with a live sampler watching that `remaining` never dips below 0;
  - 60 parallel HTTP chats through the full gateway, where ledger Σcharged + Redis remaining
    equals the initial budget exactly (`test/concurrency/`).
- **Every failure path has a test with observable consequences in Redis and the ledger**:
  - client disconnect over real sockets (the upstream request is cancelled within 1 s);
  - mid-stream provider error and dropped connection;
  - Redis down (503, fail closed, no provider call);
  - Postgres down (stream served, failure logged, readyz fails);
  - double reconcile;
  - drain-deadline shutdown, including a real SIGTERM inside a Linux container;
  - a real **SIGKILLed gateway process** whose reservation is swept after its TTL and
    charged in full.
- **Bugs this design caught:**
  - **Sink errors were misclassified as provider errors.** A transport bug would have been
    reported as `stream_error` and charged to the student. Fixed by classifying only
    `iterator.next()` failures.
  - **Zero-cost CPU DoS in the tokenizer.** A single 32 k-char run took 3.8 s of event-loop time,
    found while testing FR3 limits. Fixed with chunked BPE (ADR-0008).
- **Cost on the hot path:** two Redis round trips to reserve (index + script) and one to settle.
  Measured overhead before the first token is in [LOAD_TEST.md](LOAD_TEST.md).
- **Trade-offs I accepted:**
  - A crash charges the full reservation, which can over-charge the student by the unused tail.
  - Up to ~1 s of budget writes can be lost on a hard Redis crash (AOF `everysec`, ADR-0016).
  - The ledger is best-effort when Postgres is down (ADR-0010).

  Each is documented, and each errs on the side of never exceeding the budget.

# ADR-0003: Redis `TIME` is the clock for every cross-instance decision

- Status: accepted
- Date: 2026-10-03

## Context

Several decisions compare timestamps written by one gateway instance with "now" on another:
rate-limit windows (GCRA theoretical arrival time), reservation expiry, and the sweeper deciding
a reservation is abandoned. Instance clocks drift and NTP can step them. If instance A wrote an
expiry with its clock and instance B judged it with B's clock, a skew of a few seconds could:

- expire a _live_ reservation early (the sweeper charges it in full while the stream is running), or
- let a rate-limit window open early.

## Decision

- **All cross-instance time decisions read `redis.call('TIME')` inside the Lua script** that makes
  the decision: `rate_limit_gcra.lua`, `reserve.lua` (expiresAt = TIME + TTL), and
  `claim_expired.lua` (expired iff expiresAt ≤ TIME). One clock, read atomically with the data.
- The injected `Clock` port (`SystemClock`) is used only for **local durations** (latency, TTFT,
  timeouts, drain deadline), with a monotonic source, and for the _provisional_ score of the
  reservation-expiry index (ADR-0005). That score is only a hint for which entries to look at; the
  authoritative expiry is re-checked against Redis `TIME` before anything is claimed.

## Consequences

- Clock skew between instances can't affect correctness, only how early the sweeper _looks_ at
  an entry.
- Scripts that call `TIME` are non-deterministic. That is fine with Redis ≥ 5 (effects
  replication, the default since 7). Compose and CI use Redis 7.4.
- Unit tests of application logic use a fake `Clock`. Time-based Redis behaviour is tested
  against real Redis (integration) with short periods.

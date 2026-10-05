# ADR-0016: Redis must run with `noeviction` and persistence

- Status: accepted
- Date: 2026-10-03

## Context

Redis is the source of truth for remaining budget (FR5). The reserve script initialises a budget
with `SET NX` from the token's `token_budget` **when the key does not exist**. So a lost budget key
is not an error: it silently becomes a _fresh full allowance_. Keys can be lost in three ways:

1. Eviction under memory pressure (`allkeys-lru` and similar policies).
2. A restart without persistence.
3. TTL expiry while the attempt is still in use.

## Decision

- Redis runs with `maxmemory-policy noeviction`. Under memory pressure, writes fail. That surfaces
  as a 503 (fail closed), never as a reset budget.
- AOF persistence with `appendfsync everysec`. This is the compose setting; a managed Redis must be
  configured the same way. At most ~1 s of budget writes can be lost in a crash.
- Per-attempt keys carry `ATTEMPT_TTL_SECONDS` (default 30 days), refreshed on every reserve. The
  value must be longer than any attempt's lifetime.

## Consequences

- Operators must not "optimise" Redis to an LRU cache policy; the README and this ADR say why.
- Residual risk (documented limitation): losing ≤ 1 s of AOF on a hard crash could refund recently
  charged tokens. Closing it would need `appendfsync always` (slower) or a Postgres-backed budget
  (slower, and outside the spec's Redis design).

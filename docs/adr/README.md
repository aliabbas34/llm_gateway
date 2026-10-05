# Architecture Decision Records

| #                                                      | title                                                                           | status   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)          | Record architecture decisions                                                   | accepted |
| [0002](0002-fallback-provider-mistral.md)              | Fallback provider is Mistral (free Experiment plan); Cerebras is no longer free | accepted |
| [0003](0003-clock-source.md)                           | Redis TIME is the clock for every cross-instance decision                       | accepted |
| [0004](0004-reserve-inside-service.md)                 | Reserve runs inside the service try/finally, not a hook                         | accepted |
| [0005](0005-reservation-expiry-index.md)               | Reservation expiry index: written first, claimed atomically                     | accepted |
| [0006](0006-budget-exhausted-is-403.md)                | Budget exhausted → 403 `budget_exhausted`, not 429                              | accepted |
| [0007](0007-oversized-body-is-400.md)                  | Oversized and malformed bodies return 400                                       | accepted |
| [0008](0008-token-counting.md)                         | Local token counting: chunked o200k BPE + multiplier                            | accepted |
| [0009](0009-client-ip-and-trust-proxy.md)              | Client IP for rate limiting — trust no proxy by default                         | accepted |
| [0010](0010-async-ledger-writes.md)                    | Ledger writes are async and best-effort                                         | accepted |
| [0011](0011-stream-duration-below-reservation-ttl.md)  | Max stream duration strictly below reservation TTL                              | accepted |
| [0012](0012-integration-tests-use-compose-services.md) | Integration tests use compose / CI service containers                           | accepted |
| [0013](0013-which-requests-get-ledger-rows.md)         | Which requests get a ledger row                                                 | accepted |
| [0014](0014-server-generated-request-ids.md)           | Request IDs are generated server-side only                                      | accepted |
| [0015](0015-dependency-version-pins.md)                | Dependency version pins that deviate from "latest"                              | accepted |
| [0016](0016-redis-persistence-and-eviction.md)         | Redis must run with noeviction and persistence                                  | accepted |
| [0017](0017-failover-and-timeouts.md)                  | Failover and timeout semantics                                                  | accepted |
| [0018](0018-graceful-shutdown.md)                      | Graceful shutdown sequence                                                      | accepted |
| [0019](0019-dedicated-upstream-connection-pool.md)     | Provider calls use a dedicated undici connection pool                           | accepted |

Format: Context → Decision → Consequences (→ Alternatives), see ADR-0001. ADRs are append-only.

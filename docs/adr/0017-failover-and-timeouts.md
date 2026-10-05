# ADR-0017: Failover and timeout semantics

- Status: accepted
- Date: 2026-10-03

## Context

FR6 says: fail over only before the first byte reaches the client, only to `fallback_models`,
and only on 429 / 5xx / timeout / connection error; after the first byte, send an SSE error event
and close. The spec also asks for configurable connect/TTFT and idle timeouts. Several details
are left open.

## Decision

**Commit point.** The response is committed (status 200 + SSE headers) on the first _real_
output from a provider: a non-empty delta or a finish. Role-only or empty chunks don't commit.
Until then, the client has received nothing, so failover is invisible to it.

**Retryable kinds.** Classified once, in `ProviderError` (domain): `rate_limited`,
`server_error`, `timeout`, `connection`. Not retryable before the first byte:

- `client_error` (other 4xx): our request or key is wrong, and the next vendor would likely say the same;
- `protocol_error`: a malformed stream is a bug to surface, not to mask.

Neither is in the FR6 list, so the safe reading is: no failover, answer 502.

**Timeouts are provider errors.** A per-attempt `Watchdog` aborts the attempt's signal with
`ProviderError('timeout')`. Adapters re-throw a `ProviderError` abort reason unchanged, so
timeouts flow through the same classification as an HTTP 503. No adapter special-cases them.

- `PROVIDER_TTFT_TIMEOUT_MS` (10 s): request sent → first chunk. Covers connect, TLS, queueing
  and model latency. (`fetch` has no separate connect timeout without a custom dispatcher; one
  timer for both is simpler and matches what the student experiences.)
- `PROVIDER_IDLE_TIMEOUT_MS` (20 s): silence between chunks. **Paused while we write to the
  client**, so a slow client is never blamed on the provider.
- `MAX_STREAM_DURATION_MS` (300 s): one deadline for the whole request, across failovers (ADR-0011).

**Slow consumers.** A client that doesn't drain its socket for `SSE_WRITE_TIMEOUT_MS` (30 s) is
disconnected. That aborts the upstream, and the request is charged as `client_disconnected`.
Without this, one stuck tab could pin a provider stream and a reservation until the max duration.

**After the first byte.** `stream_error` with an in-stream `event: error`
(`upstream_timeout` or `upstream_error`), no `[DONE]`. Charged: input plus what was streamed
(capped at the reservation).

**Client gone.** No failover: nobody is waiting for the answer. The client is gone when the
request signal was aborted with a reason that is not a `ProviderError`.

**Budget across failover.** One reservation per request, reused by every candidate with the same
`max_tokens`. A failed candidate consumed nothing billable to the student, so the fallback can
use the full reservation.

## Consequences

- Each candidate can take up to TTFT timeout, so the worst-case time to 502 is
  `candidates × TTFT` (20 s with defaults), bounded by the max stream duration.
- `failover_count` and `failover_reasons` are logged, and the count is in the ledger.
- Tested in `test/unit/application/failover.test.ts` (service) and
  `test/e2e/failover.e2e.test.ts` (real HTTP: 503, 429, never-sends-headers, 400, all-down, stall).

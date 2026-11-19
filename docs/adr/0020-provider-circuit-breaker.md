# ADR-0020: Skip failing models with a per-instance circuit breaker

- Status: accepted
- Date: 2026-11-18
- Amends: ADR-0017

## Context

Failover (FR6) tries the primary first on every request. During an outage where the primary hangs,
every message waits for the full TTFT timeout (10 s) before reaching the fallback. The gateway
learned nothing from the previous failure.

## Decision

Each configured model has a circuit breaker in `ChatCompletionService`'s failover loop:

- **Closed:** the model is called normally.
- **Open:** after `CIRCUIT_FAILURE_THRESHOLD` (3) consecutive failures, the model is skipped for
  `CIRCUIT_OPEN_MS` (30 s), and requests go straight to the next candidate.
- **Half-open:** after that, one request probes the model while the others keep skipping it. A
  finished answer closes the circuit; a failure opens it for another 30 s.

What counts:

| event                                                                | effect                     |
| -------------------------------------------------------------------- | -------------------------- |
| a completed stream                                                   | success (resets the count) |
| 429, 5xx, timeout, connection error, before or during the stream     | failure                    |
| client left, shutdown, request deadline, other 4xx, malformed stream | ignored                    |

If every candidate is skipped, the gateway answers `502 upstream_unavailable` immediately, with
`Retry-After` set to the time until the next probe. The reservation is released and the ledger row
has no model, because no provider was called.

State is in memory, per instance and per model. It is only a hint about health: losing it costs a
few slow requests, and budget correctness never depends on it.

## Consequences

- During an outage only the first few requests per instance, and one probe every 30 s, wait for the
  timeout.
- Instances learn independently, so N instances make up to N × 3 failing calls before all skip the
  model. Sharing state in Redis would add a round trip to every request for little gain.
- A request can reach the fallback with `failover_count = 0`; `skipped_models` in the completion log
  and the `gateway_circuit_state` metric show why.
- A failure after the first output still cannot fail over (FR6). It only counts towards the circuit,
  which protects the user's next message.
- Tested in `test/unit/application/CircuitBreaker.test.ts` and `test/e2e/failover.e2e.test.ts`.

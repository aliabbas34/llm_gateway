# ADR-0019: Provider calls use a dedicated undici connection pool

- Status: accepted
- Date: 2026-10-03

## Context

PLAN.md listed "outbound connection pool to providers" as a risk, and P3 first shipped with
Node's global `fetch`. The P9 load test then showed a far higher gateway overhead than the
per-operation costs allowed. Measurements on the dev machine (Windows 11, Node 22.23.1,
loopback):

| client                                                         | p50 per request |
| -------------------------------------------------------------- | --------------- |
| global `fetch` (bundled undici 6.x, default global dispatcher) | **15.4 ms**     |
| `undici` 8.11.2 `fetch` / `request`, default dispatcher        | 15–16 ms        |
| `undici` 8.11.2 `fetch` with an explicit `new Agent()`         | **1.2 ms**      |
| `http.request` with a keep-alive agent                         | 0.6 ms          |

The ~15 ms matches the Windows timer resolution (15.6 ms): the default dispatcher was paying
about one timer tick per request. On Linux the difference is far smaller, but the dedicated pool
is the better design regardless.

## Decision

- `undici@8.11.2` is a production dependency (engines raised to Node ≥ 22.19).
- `gateway.ts` creates one `Agent({ connections: UPSTREAM_MAX_CONNECTIONS })` (default 1024 per
  origin; each live HTTP/1.1 stream holds one connection, and NFR1 asks for 500) and injects a
  `fetch` bound to it into every provider adapter.
- The adapter depends on a small structural `FetchFn` type, not on `typeof fetch` (ISP): undici's
  fetch, the global fetch and test doubles all fit without casts.
- The pool is closed during graceful shutdown, after streams have drained.

## Consequences

- Upstream connection limits and keep-alive are explicit configuration, not an accident of
  global state.
- Timeouts stay in our `Watchdog` (ADR-0017); undici's own headers/body timeouts (300 s)
  are left as an outer backstop.

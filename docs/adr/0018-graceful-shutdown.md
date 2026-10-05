# ADR-0018: Graceful shutdown sequence

- Status: accepted
- Date: 2026-10-03

## Context

Spec: on SIGTERM, `/readyz` → 503, stop accepting, drain streams up to a configurable deadline,
abort the rest and reconcile/release them, close Redis and Postgres pools, exit 0. Streams are
long (up to minutes), and every one holds a budget reservation.

## Decision

`Gateway.shutdown()` (src/gateway.ts), idempotent, in this order:

1. **Not ready.** `lifecycle.startDraining()`: `/readyz` → 503 (the load balancer stops routing),
   and `DrainableChatCompletion` refuses new chats with `503 shutting_down` + `Retry-After: 1`.
   Stop the sweeper.
2. **Stop accepting.** `app.close()` closes the listener (new connections are refused) and idle
   keep-alive sockets. In-flight streams keep running.
3. **Drain** up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (25 s): wait for every in-flight completion.
4. **Abort stragglers** at the deadline with one shared `ShutdownAbort` signal. Each one:
   - before its first byte: releases its reservation, answers `503 shutting_down` (retry elsewhere);
   - after its first byte: reconciles input + streamed tokens and ends with
     `event: error` `shutting_down`;
   - writes a `shutdown_aborted` ledger row.

   They get 5 s to settle.

5. **Close connections that became idle during the drain** (`closeIdleConnections()`; otherwise
   `close()` waits for each client's keep-alive timeout, which tests measured at 5 s), then force
   any remainder after the grace.
6. Flush pending ledger writes, `QUIT` Redis, end the Postgres pool.
7. `server.ts` exits 0, plus a hard limit (drain + 15 s → exit 1) in case something hangs.

## Consequences

- Orchestrator settings must match: termination grace period > drain timeout (compose:
  `stop_grace_period: 40s`), and ideally a short `preStop` delay so endpoint removal propagates
  before the listener closes. Connections that still arrive in that gap are refused, which
  clients see as a connection error and retry.
- No reservation is left for the sweeper after a graceful stop: every stream settles itself.
  Only a crash (SIGKILL, OOM) relies on the sweeper (ADR-0005).
- Verified three ways:
  - in-process: `test/e2e/shutdown.e2e.test.ts` (drain completes; deadline aborts and settles);
  - with a real SIGTERM to a child process: Linux CI, skipped on Windows, where `kill()` is TerminateProcess;
  - in Docker: `docker compose stop` mid-stream → `shutting_down` event, ledger row, exit 0 in ~1.15 s
    with a 1 s drain.

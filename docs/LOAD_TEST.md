# Load test: NFR1 (500 concurrent streams) and NFR3 (≤ 50 ms p95 added before first token)

Run it yourself:

```bash
docker compose up -d --wait
```

```bash
npm run build
```

```bash
npm run load-test -- --levels 1,10,50,100,500 --duration 15 --stream-connections 500
```

Script: [scripts/load-test/run.ts](../scripts/load-test/run.ts). Raw JSON and per-run gateway logs
go to `load-test-results/` (git-ignored).

## Method

All processes run on **one machine**: autocannon (load generator), the fake provider, the
**built** gateway (`node dist/server.js`, production code path: JWT, Redis GCRA limits, Lua
reserve/settle, Postgres ledger, SSE re-emit, `LOG_LEVEL=info`), and Redis and Postgres in Docker
Desktop's VM. Every connection uses its own attempt token.

Two measurements:

1. **Added latency, server side (the NFR3 number).** For each request the gateway computes
   `added = pipeline time (rate limits, auth, validation) + (TTFT − the serving provider's own TTFT)`
   from its own clocks. It logs it as `added_latency_ms` and exports the
   `gateway_added_latency_seconds` histogram. This excludes the provider's latency and any slowness
   of a saturated fake provider. Percentiles below are exact, from the gateway's log.
2. **Client side.** autocannon latency for the same workload against the fake directly
   (baseline) and through the gateway. The fake answers after 100 ms with one token, so latency ≈
   time to first token. The difference is an upper bound that also includes contention between
   processes sharing the CPU.

## Results (2026-10-03)

Hardware: **Intel i3-1115G4 (2 cores / 4 threads, 15 W laptop), 7.7 GB RAM, Windows 11**,
Node 22.23.1, Docker Desktop VM with 4 vCPU for Redis 7.4 and Postgres 17. 15 s per run.

| concurrent requests | baseline p50 / p97.5 ms | gateway p50 / p97.5 ms | gateway req/s | errors / non-2xx | **added p50 / p95 / p99 ms** | event-loop lag p99 ms |
| ------------------- | ----------------------- | ---------------------- | ------------- | ---------------- | ---------------------------- | --------------------- |
| 1                   | 114 / 119               | 118 / 142              | 8             | 0                | **5.5 / 14.7 / 19.7**        | 25                    |
| 10                  | 116 / 129               | 143 / 227              | 68            | 0                | **14.7 / 43.2 / 71**         | 29                    |
| 50                  | 116 / 133               | 260 / 491              | 184           | 0                | **68.9 / 159.7 / 311.9**     | 82                    |
| 100                 | 117 / 140               | 460 / 1041             | 199           | 0                | **165.2 / 373.6 / 475.3**    | 175                   |
| 500                 | 128 / 219               | 1823 / 3377            | 232           | 0                | **663.1 / 1415.7 / 1445.9**  | 802                   |

**500 concurrent streams (NFR1):** 500 simultaneous streams of 100 tokens, 100 ms apart (≈ 10 s each,
realistic LLM pacing).

- 500 / 500 completed; 0 errors, 0 non-2xx, 0 timeouts.
- Added latency for that burst: p50 967 ms / p95 1 033 ms. All 500 requests arrived in the same
  instant, so most of that is time waiting to be admitted (see below).

### Verdict

- **NFR3 (≤ 50 ms p95 added) is met uncontended and up to ~10 concurrent requests per instance
  on this laptop:** p95 14.7 ms at 1, 43.2 ms at 10. It is **not** met at higher arrival rates on
  this hardware: p95 160 ms at 50, 374 ms at 100.
- **NFR1 (500 concurrent streams) is met for stability:** 500 / 500 streams served without an
  error. Its time-to-first-token target is not met when all 500 arrive in the same instant.
- The gateway is **CPU-bound at ~200–230 new requests/s on this machine**. Beyond that,
  latency is queueing: event-loop lag rises in step with added latency.

### Why, and what it means for production

- **Measured cost:** about **5 ms of gateway CPU per request** on this laptop, from
  `process_cpu_seconds_total` at 20 concurrent. The CPU profile has no single hot spot. It is spread
  over Fastify, the undici upstream client, ioredis (4 commands per request), pg (the ledger
  insert costs only ~0.3 ms), and our own SSE and streaming layers.
- **This hardware is slow per request:** an Ed25519 JWT verification took 0.7 ms here, about 10×
  a typical server core. Four processes share 4 hardware threads with a 4-vCPU VM, and autocannon
  at 500 connections is itself CPU-heavy. A server core would plausibly serve several times more
  requests per second, but that's an **unverified extrapolation**, not a measured result.
- **Real streams arrive at low rates.** 500 concurrent 10–30 s LLM streams ≈ 17–50 new
  requests/s, well under the measured knee. Keeping 500 streams open costs little; _admitting_
  many at once is the expensive part. The gateway is stateless, so arrival rate scales
  horizontally: instances × ~200 req/s on this laptop.
- **Operational guardrail:** alert on `gateway_added_latency_seconds` p95 and event-loop lag,
  and autoscale on in-flight streams (`gateway_active_streams`) plus request rate.

### Findings from the load test (all fixed, with tests)

| finding                                                                                       | effect                                                                                                 | fix                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| GCRA `SET … PX 0` when the limit is so high the emission interval underflows double precision | rate limiter failed closed: 503s (974 non-2xx in the first run)                                        | `math.max(1, …)` + regression test                                                             |
| Node's global `fetch` dispatcher: ~15 ms per request on Windows loopback (one timer tick)     | every upstream call +15 ms                                                                             | dedicated undici `Agent` ≈ 1.2 ms ([ADR-0019](adr/0019-dedicated-upstream-connection-pool.md)) |
| `ZADD` index and reserve script were two sequential round trips                               | +1 RTT before the first token                                                                          | one pipeline, index still first, undo if only the index failed (ADR-0005)                      |
| One ledger INSERT per row                                                                     | a burst (sweeper claiming ~470 stranded reservations) exhausted the pg pool acquire timeout: rows lost | batched multi-row INSERTs (ADR-0010)                                                           |
| No way to separate gateway overhead from provider latency                                     | NFR3 not measurable                                                                                    | `added_latency_ms` log field + `gateway_added_latency_seconds` histogram                       |

Before these fixes the 500-connection run showed 974 non-2xx responses and 89 req/s. After them:
0 errors and ~230 req/s.

### What would make the result conclusive

Run the gateway on dedicated cores (for example a 2-vCPU Linux VM), with Redis and Postgres on
their own hosts and the load generator on another machine. Then report the same table. The script
takes `--redis-url` / `--database-url`, and the server-side added-latency measurement doesn't depend
on the load generator's speed.

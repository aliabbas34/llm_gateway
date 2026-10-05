# ADR-0012: Integration tests use docker compose / CI service containers, not testcontainers

- Status: accepted
- Date: 2026-10-03

## Context

Integration, concurrency and e2e tests need real Redis (Lua semantics, `TIME`, atomicity) and
real Postgres (enum, constraints, `ON CONFLICT`). The stack allows either testcontainers or
compose services.

## Decision

Use the same `docker-compose.yml` services developers already run for `npm run dev`. In CI, use
GitHub Actions `services:` with identical images and host ports. Tests read `TEST_REDIS_URL` /
`TEST_DATABASE_URL` (defaults match compose). A Vitest `globalSetup` checks connectivity, fails
with an actionable message ("run docker compose up -d --wait"), and applies migrations once.

Isolation comes from data rather than containers: every test uses a unique attempt id / request
id, so test files run in parallel against shared instances without flushing anything.

## Consequences

- One definition of the infrastructure for dev, tests and CI. No Docker-in-Docker, and no
  container start-up per test file, so it is fast on Windows/WSL2 too.
- Tests can't stop "their" Redis to simulate an outage. Redis-down tests point a client at a
  closed port instead, which exercises the same code path (connection refused / offline).
- A developer must start compose before `npm run test:integration`; the setup error says so.

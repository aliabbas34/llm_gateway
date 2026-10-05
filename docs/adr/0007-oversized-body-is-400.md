# ADR-0007: Oversized and malformed bodies return 400, not 413/415

- Status: accepted
- Date: 2026-10-03

## Context

FR3 says a body over 256 KB is a **400**. Fastify's `bodyLimit` raises `FST_ERR_CTP_BODY_TOO_LARGE`
with status **413**. Malformed JSON is 400, and an unsupported content type is 415. The spec's
status vocabulary is 400/401/403/429/502/503 (+ 500 for bugs).

## Decision

The error handler maps **every Fastify-originated 4xx** (`FST_*` code, 400 ≤ status < 500) to
`ValidationError` → `400 invalid_request`. The body limit itself is still enforced by Fastify's
streaming `bodyLimit`, so oversized bodies are rejected without being buffered.

## Consequences

- Clients see one error code for "your request is wrong", matching the spec.
- We lose the more specific 413/415 semantics. That is acceptable for a single first-party client,
  and the log line keeps the original Fastify code for debugging.
- 404 for unknown routes is kept: it is routing, not request validation.

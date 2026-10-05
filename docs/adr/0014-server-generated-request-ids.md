# ADR-0014: Request IDs are generated server-side only

- Status: accepted
- Date: 2026-10-03

## Context

NFR8 needs a request ID on every log line. Gateways often accept an incoming `X-Request-Id`.
Here, though, the request ID is also the **unique key of the usage ledger** (FR8). If a client
supplied it, two requests could share an ID. The second ledger insert would then be dropped by
`ON CONFLICT DO NOTHING` and a charge would disappear from the audit trail. A client could also
inject odd strings into logs.

## Decision

- Fastify `genReqId` uses the injected `IdGenerator` (UUID v4); `requestIdHeader: false`.
- The ID is returned in the `x-request-id` response header and in every error body.
- A client-sent `x-request-id` (≤ 128 chars) is logged as `client_request_id` for correlation only.

## Consequences

- Ledger uniqueness is guaranteed by construction.
- Upstream tracing systems that propagate their own ID can still be correlated through
  `client_request_id`.

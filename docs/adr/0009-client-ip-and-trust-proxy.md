# ADR-0009: Client IP for rate limiting — trust no proxy by default

- Status: accepted
- Date: 2026-10-03

## Context

FR4 rate-limits per IP _before_ auth. The IP must come from somewhere: the socket address, or
`X-Forwarded-For` when behind a load balancer. Trusting `X-Forwarded-For` blindly lets any client
choose its own IP and bypass the limit.

## Decision

`TRUST_PROXY_HOPS` (default **0**) is the number of reverse proxies in front of the gateway. Fastify
is given a trust function `hop < TRUST_PROXY_HOPS`, so exactly that many right-most
`X-Forwarded-For` entries are skipped and the next one is the client. With 0, the socket address
is used and the header is ignored.

## Consequences

- Safe by default. Behind one load balancer, operators set `TRUST_PROXY_HOPS=1`.
- A misconfiguration (too low) makes all traffic look like the load balancer's IP, so the per-IP
  limit becomes a global limit. That fails _closed_ (more 429s), not open.

## Alternatives

- Trust everything (`trustProxy: true`): rejected; it makes the IP limit spoofable.
- An allowlist of proxy CIDRs: more precise, but needs network knowledge we don't have yet. The
  hop count covers the expected single-LB deployment.

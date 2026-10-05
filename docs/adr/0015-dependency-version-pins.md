# ADR-0015: Dependency version pins that deviate from "latest"

- Status: accepted
- Date: 2026-10-03

## Context

All dependencies are pinned exactly (`save-exact=true` in `.npmrc`). The newest release of two
packages was not the safest choice on 2026-10-03.

## Decision

| package       | pinned  | latest | why                                                                                                                                                     |
| ------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`  | 6.0.3   | 7.0.2  | `typescript-eslint@8.71.0` declares `typescript <6.1.0`. Type-aware linting is a quality gate, so the compiler follows the linter.                      |
| `ioredis`     | 5.11.1  | 6.0.0  | 6.0.0 is two months old, a new major. 5.x is the long-proven line and has everything we need (`defineCommand`, `enableOfflineQueue`, `commandTimeout`). |
| `@types/node` | 22.20.5 | 26.x   | Types must match the runtime (Node 22 LTS), or we could call APIs that don't exist at runtime.                                                          |

## Consequences

Revisit when typescript-eslint supports TS 7 and ioredis 6 has a few patch releases.

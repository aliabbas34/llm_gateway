# ADR-0001: Record architecture decisions

- Status: accepted
- Date: 2026-10-03

## Context

The spec is frozen, and some requirements are ambiguous. The working rules say: pick the safest
option, record it, and move on. A future reader comparing implementations needs to see _why_,
not just _what_.

## Decision

Every non-obvious decision is a short Markdown ADR in `docs/adr/NNNN-title.md` with the sections
**Context, Decision, Consequences** (and **Alternatives** when they were seriously considered).
ADRs are append-only: a changed decision gets a new ADR that supersedes the old one.
The index lives in [README.md](README.md).

## Consequences

- Disagreements with the spec live here, never as silent edits to `SPEC.md`.
- Code comments reference ADRs (`ADR-0006`) instead of repeating the rationale.

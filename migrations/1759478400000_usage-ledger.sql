-- Up Migration

-- How a request ended. Mirrors `Outcome` in src/domain/types.ts.
CREATE TYPE usage_outcome AS ENUM (
  'completed',             -- stream finished normally
  'client_disconnected',   -- client went away; upstream aborted, streamed tokens charged
  'upstream_error',        -- every candidate failed before the first byte (502)
  'stream_error',          -- provider failed after the first byte (SSE error event)
  'budget_exhausted',      -- reserve rejected: not enough allowance left
  'attempt_closed',        -- reserve rejected: attempt closed
  'shutdown_aborted',      -- aborted at the shutdown drain deadline
  'expired_unreconciled'   -- reservation expired without reconcile (crash); charged in full by the sweeper
);

-- One row per gateway request that reached the reserve step (ADR-0013).
CREATE TABLE usage_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      text          NOT NULL,
  attempt_id      text          NOT NULL,
  student_id      text          NOT NULL,
  model           text,                      -- NULL when no provider was called
  provider        text,
  input_tokens    integer       NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer       NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reserved_tokens integer       NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  charged_tokens  integer       NOT NULL DEFAULT 0 CHECK (charged_tokens >= 0),
  outcome         usage_outcome NOT NULL,
  latency_ms      integer       NOT NULL CHECK (latency_ms >= 0),
  ttft_ms         integer                CHECK (ttft_ms >= 0),
  failover_count  smallint      NOT NULL DEFAULT 0 CHECK (failover_count >= 0),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_request_id_key UNIQUE (request_id),
  -- The hard-limit invariant, enforced again at the storage layer.
  CONSTRAINT usage_ledger_charged_le_reserved CHECK (charged_tokens <= reserved_tokens)
);

CREATE INDEX usage_ledger_attempt_created_idx ON usage_ledger (attempt_id, created_at);

-- Down Migration

DROP TABLE usage_ledger;
DROP TYPE usage_outcome;

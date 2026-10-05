import type pg from 'pg';
import type { UsageLedger } from '../../domain/ports.js';
import type { UsageEntry } from '../../domain/types.js';

const COLUMNS = [
  'request_id',
  'attempt_id',
  'student_id',
  'model',
  'provider',
  'input_tokens',
  'output_tokens',
  'reserved_tokens',
  'charged_tokens',
  'outcome',
  'latency_ms',
  'ttft_ms',
  'failover_count',
] as const;

/** Postgres allows 65 535 bind parameters per statement; stay well below. */
export const MAX_ROWS_PER_INSERT = 1_000;

/**
 * Append-only ledger. One multi-row INSERT per batch: a burst (the sweeper claiming hundreds of
 * reservations, a traffic spike) costs one round trip and one pooled connection, not one each.
 * `ON CONFLICT (request_id) DO NOTHING` makes a repeated write for one request a no-op.
 */
export class PgUsageLedger implements UsageLedger {
  constructor(private readonly pool: pg.Pool) {}

  async record(entries: readonly UsageEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i += MAX_ROWS_PER_INSERT) {
      const chunk = entries.slice(i, i + MAX_ROWS_PER_INSERT);
      const values: unknown[] = [];
      const rows = chunk.map((e) => {
        const base = values.length;
        values.push(
          e.requestId,
          e.attemptId,
          e.studentId,
          e.model,
          e.provider,
          e.inputTokens,
          e.outputTokens,
          e.reservedTokens,
          e.chargedTokens,
          e.outcome,
          Math.round(e.latencyMs),
          e.ttftMs === null ? null : Math.round(e.ttftMs),
          e.failoverCount,
        );
        return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
      });
      await this.pool.query(
        `INSERT INTO usage_ledger (${COLUMNS.join(', ')}) VALUES ${rows.join(', ')}
         ON CONFLICT (request_id) DO NOTHING`,
        values,
      );
    }
  }
}

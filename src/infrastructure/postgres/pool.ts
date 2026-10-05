import pg from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../../config/loadConfig.js';

/**
 * Postgres pool. Statement and connect timeouts are short: the ledger is off the hot path, and
 * a slow database must not pile up waiting work in the gateway.
 */
export function createPgPool(config: Pick<Config, 'postgres'>, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.postgres.url,
    max: config.postgres.poolMax,
    statement_timeout: config.postgres.statementTimeoutMs,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: 'llm-gateway',
  });
  // Errors on idle clients (e.g. the server restarted) must not crash the process.
  pool.on('error', (err) => {
    logger.warn({ err: { message: err.message, name: err.name } }, 'postgres idle client error');
  });
  return pool;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** Repo-root `migrations/` directory, resolved relative to this file (works from src/ and dist/). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

/**
 * Apply all pending migrations. Used by `npm run migrate` and by the integration-test setup.
 * node-pg-migrate takes an advisory lock, so concurrent runs are safe.
 */
export async function migrateUp(
  databaseUrl: string,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log,
  });
}

/**
 * Migration entry point (`npm run migrate`, or `node dist/migrate.js` in the container).
 * Only needs DATABASE_URL, so it doesn't load the full gateway config.
 */
import { migrateUp } from './infrastructure/postgres/migrate.js';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  process.stderr.write('DATABASE_URL is required\n');
  process.exitCode = 1;
} else {
  migrateUp(url, (msg) => process.stdout.write(`${msg}\n`)).catch((err: unknown) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

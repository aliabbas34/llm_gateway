/**
 * Close an attempt, as the product backend would when the interview ends.
 *
 *   npm run close-attempt -- --attempt att-1 [--url http://localhost:8080]
 *
 * Reads SERVICE_API_KEY from the environment (.env is loaded by the npm script).
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    attempt: { type: 'string' },
    url: { type: 'string', default: process.env.GATEWAY_URL ?? 'http://localhost:8080' },
  },
});

const key = process.env.SERVICE_API_KEY;
if (values.attempt === undefined || key === undefined) {
  console.error('usage: close-attempt --attempt <id>   (SERVICE_API_KEY must be set)');
  process.exit(2);
}

const res = await fetch(`${values.url}/v1/attempts/${encodeURIComponent(values.attempt)}/close`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
});
console.log(res.status, await res.text());
process.exitCode = res.ok ? 0 : 1;

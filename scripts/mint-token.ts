/**
 * Mint an attempt JWT, as the product backend would.
 *
 *   npm run mint-token -- --attempt att-1 --student stu-1 --budget 20000 --cap 1024 --ttl 900
 *
 * Prints only the token, so it composes: TOKEN=$(npm run -s mint-token -- --attempt att-1)
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { importPrivateKey, mintAttemptToken } from './lib/tokens.js';

const { values } = parseArgs({
  options: {
    attempt: { type: 'string', default: 'att-demo' },
    student: { type: 'string', default: 'stu-demo' },
    budget: { type: 'string', default: '20000' },
    cap: { type: 'string', default: '1024' },
    ttl: { type: 'string', default: '900' },
    key: { type: 'string', default: 'keys/private.pem' },
  },
});

const privateKey = await importPrivateKey(readFileSync(values.key, 'utf8'));
const token = await mintAttemptToken(privateKey, {
  attemptId: values.attempt,
  studentId: values.student,
  tokenBudget: Number(values.budget),
  maxTokensCap: Number(values.cap),
  ttlSec: Number(values.ttl),
});
console.log(token);

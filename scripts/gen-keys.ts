/**
 * Generate an Ed25519 key pair for local development.
 *
 *   npm run gen-keys            → writes keys/private.pem and keys/public.pem (git-ignored)
 *
 * The private key stays with the (simulated) backend: mint-token.ts reads it. The gateway gets
 * only the public key, via JWT_PUBLIC_KEY; the one-line form for .env is printed below.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateEd25519KeyPair } from './lib/tokens.js';

const { values } = parseArgs({
  options: { dir: { type: 'string', default: 'keys' }, force: { type: 'boolean', default: false } },
});
const dir = path.resolve(values.dir);
const privatePath = path.join(dir, 'private.pem');
const publicPath = path.join(dir, 'public.pem');

if (existsSync(privatePath) && !values.force) {
  console.error(`${privatePath} already exists; pass --force to overwrite.`);
  process.exit(1);
}

const { privatePem, publicPem } = await generateEd25519KeyPair();
mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privatePem, { mode: 0o600 });
writeFileSync(publicPath, publicPem);

console.log(`wrote ${privatePath}`);
console.log(`wrote ${publicPath}`);
console.log('\nAdd this line to .env:\n');
console.log(`JWT_PUBLIC_KEY="${publicPem.trim().replace(/\n/g, '\\n')}"`);

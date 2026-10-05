/**
 * Run the OpenAI-compatible fake provider (see scripts/lib/fakeProviderServer.ts for scenarios).
 *
 *   npm run fake-provider -- --port 8090
 *
 * Then point the gateway at it:
 *   FAKE_PROVIDER_BASE_URL=http://localhost:8090/v1 PRIMARY_MODEL=fake:ok FALLBACK_MODELS=
 */
import { parseArgs } from 'node:util';
import { startFakeProviderServer } from './lib/fakeProviderServer.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8090' },
    host: { type: 'string', default: '0.0.0.0' },
  },
});

const server = await startFakeProviderServer({ port: Number(values.port), host: values.host });
console.log(`fake provider listening on ${server.url}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}

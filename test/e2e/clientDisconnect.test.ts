/**
 * Real sockets end to end: client → gateway (listening on a port) → fake provider over HTTP.
 * When the client hangs up mid-stream, the gateway must cancel the upstream request: otherwise
 * the provider keeps generating (and billing) tokens nobody will read.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import { OpenAiCompatibleProvider } from '../../src/infrastructure/providers/OpenAiCompatibleProvider.js';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import { testToken } from '../helpers/tokens.js';

let upstream: FakeProviderServer;
let t: TestApp;
let gatewayPort: number;

beforeAll(async () => {
  upstream = await startFakeProviderServer();
  t = await buildTestApp({
    models: [
      {
        // Slow stream: 200 words, 50 ms apart (~10 s), so the client can leave midway.
        ref: { provider: 'fake', model: 'ok?words=200&gap=50' },
        provider: new OpenAiCompatibleProvider({
          name: 'fake',
          baseUrl: upstream.url,
          apiKey: 'k',
        }),
      },
    ],
  });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  gatewayPort = (t.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await t.app.close();
  await upstream.close();
});

describe('client disconnect (real sockets)', () => {
  it('aborts the upstream request soon after the client closes its connection', async () => {
    const token = await testToken();
    const upstreamCancelled = upstream.nextAbortedResponse();

    const firstBytesAt = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', () => {
            const at = Date.now();
            req.destroy(); // the student closes the tab
            resolve(at);
          });
        },
      );
      req.on('error', () => undefined); // destroy() emits ECONNRESET on the client side
      req.on('timeout', () => {
        reject(new Error('timeout'));
      });
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    });

    await upstreamCancelled;
    const cancelLatency = Date.now() - firstBytesAt;
    expect(cancelLatency).toBeLessThan(1_000); // vs ~10 s if the stream had run to completion

    // The service saw it as a client disconnect, not as a provider failure.
    await expect
      .poll(() => t.logs.records.find((r) => r.msg === 'chat completion finished'))
      .toMatchObject({ outcome: 'client_disconnected' });
  });
});

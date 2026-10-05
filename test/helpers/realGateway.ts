import type { AddressInfo } from 'node:net';
import type { Config } from '../../src/config/loadConfig.js';
import { createGateway, type Gateway } from '../../src/gateway.js';
import { createLogger } from '../../src/observability/logger.js';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import { LogCapture } from './logCapture.js';
import { testConfig } from './testConfig.js';

export interface RealGateway {
  readonly gateway: Gateway;
  readonly upstream: FakeProviderServer;
  readonly logs: LogCapture;
  readonly config: Config;
  /** Base URL of the listening gateway, e.g. http://127.0.0.1:54321 */
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * The production composition (createGateway) against real Redis + Postgres, with the fake
 * provider server as the only upstream. Listens on a random port for real-socket tests.
 */
export async function startRealGateway(
  env: Record<string, string> = {},
  options: { startSweeper?: boolean; waitForReady?: boolean; upstreamText?: string } = {},
): Promise<RealGateway> {
  const upstream = await startFakeProviderServer(
    options.upstreamText === undefined ? {} : { text: options.upstreamText },
  );
  const config = testConfig({
    FAKE_PROVIDER_BASE_URL: upstream.url,
    PRIMARY_MODEL: 'fake:ok',
    FALLBACK_MODELS: '',
    RATE_LIMIT_IP_PER_MINUTE: '100000',
    RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000',
    ...env,
  });
  const logs = new LogCapture();
  // Sweepers are off by default in tests: they would claim other test files' reservations.
  const gateway = await createGateway(config, createLogger(config, logs), {
    startSweeper: options.startSweeper ?? false,
    defaultMetrics: false,
  });
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = gateway.app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  // Like a load balancer: no traffic until /readyz is green (Redis connects in the background).
  if (options.waitForReady ?? true) await waitUntilReady(url);
  return {
    gateway,
    upstream,
    logs,
    config,
    url,
    stop: async () => {
      await gateway.shutdown('test');
      await upstream.close();
    },
  };
}

export async function waitUntilReady(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${url}/readyz`).catch(() => undefined);
    if (res?.status === 200) return;
    if (Date.now() > deadline) throw new Error(`gateway at ${url} not ready after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

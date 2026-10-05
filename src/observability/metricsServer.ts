import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Registry } from 'prom-client';

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Prometheus scrape endpoint on its own port, so it is never reachable through the public load
 * balancer that fronts the API (and needs no auth of its own). Serves only GET /metrics.
 */
export async function startMetricsServer(
  registry: Registry,
  host: string,
  port: number,
): Promise<MetricsServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });
  server.listen(port, host);
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

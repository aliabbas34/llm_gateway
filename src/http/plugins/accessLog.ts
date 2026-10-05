import type { FastifyRequest } from 'fastify';
import type { Metrics } from '../../observability/metrics.js';
import type { GatewayApp } from '../types.js';

/** Status recorded when the client closes the connection before the response ends (nginx's 499). */
const CLIENT_CLOSED = 499;

/**
 * One structured line + HTTP metrics per finished request. Logs only metadata, never headers,
 * query strings or bodies (NFR9). Fastify's built-in request logging is disabled in buildApp.
 *
 * `onResponse` fires when the response finishes, including hijacked SSE streams. A client that
 * disconnects mid-stream never "finishes" a response, and Fastify's `onRequestAbort` does not
 * fire for hijacked replies, so a raw 'close' listener records those as 499 (exactly once: a
 * finished response is skipped).
 */
export function registerAccessLog(app: GatewayApp, metrics: Metrics): void {
  const startedAt = new WeakMap<FastifyRequest, number>();

  const record = (request: FastifyRequest, status: number) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const durationMs = performance.now() - (startedAt.get(request) ?? performance.now());
    metrics.httpRequests.inc({ method: request.method, route, status: String(status) });
    metrics.httpDuration.observe({ route }, durationMs / 1000);
    request.log.info(
      { method: request.method, route, status, duration_ms: Math.round(durationMs) },
      status === CLIENT_CLOSED ? 'request aborted by client' : 'request completed',
    );
  };

  app.addHook('onRequest', async (request, reply) => {
    startedAt.set(request, performance.now());
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) record(request, CLIENT_CLOSED);
    });
  });
  app.addHook('onResponse', async (request, reply) => {
    record(request, reply.statusCode);
  });
}

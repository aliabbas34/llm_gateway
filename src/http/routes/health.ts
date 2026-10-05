import type { HealthService } from '../../application/HealthService.js';
import type { GatewayApp } from '../types.js';

/** FR9. `/healthz` = process is alive; `/readyz` = safe to receive traffic. */
export function registerHealthRoutes(app: GatewayApp, health: HealthService): void {
  app.get('/healthz', (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const r = await health.readiness();
    const status = r.ready ? 'ready' : r.draining ? 'draining' : 'unavailable';
    return reply.code(r.ready ? 200 : 503).send({ status, checks: r.checks });
  });
}

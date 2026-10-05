import type { GatewayApp } from '../types.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Request IDs are always generated server-side (Fastify `genReqId`, wired in buildApp) and never
 * taken from the client: the ID is the ledger's unique key, so a client-chosen value could collide
 * with another request's row (ADR-0014). The client's own header, if any, is logged for correlation.
 */
export function registerRequestId(app: GatewayApp): void {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    const clientId = request.headers[REQUEST_ID_HEADER];
    if (typeof clientId === 'string' && clientId.length <= 128) {
      request.log = request.log.child({ client_request_id: clientId });
    }
  });
}

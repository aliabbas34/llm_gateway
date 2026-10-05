import { z } from 'zod';
import type { AttemptService } from '../../application/AttemptService.js';
import { ATTEMPT_ID_PATTERN } from '../../domain/types.js';
import { registerServiceKeyAuth } from '../plugins/serviceKey.js';
import type { GatewayApp } from '../types.js';

const params = z.object({ id: z.string().regex(ATTEMPT_ID_PATTERN) });

/**
 * FR7: `POST /v1/attempts/:id/close`, backend-only (service key). Idempotent: closing a closed
 * attempt returns the same 200.
 */
export function registerAttemptRoutes(
  app: GatewayApp,
  deps: { attempts: AttemptService; serviceApiKey: string },
): void {
  void app.register((scope: GatewayApp, _opts, done) => {
    registerServiceKeyAuth(scope, deps.serviceApiKey);

    scope.post('/v1/attempts/:id/close', { schema: { params } }, async (request, reply) => {
      await deps.attempts.close(request.params.id);
      request.log.info({ attempt_id: request.params.id }, 'attempt closed');
      return reply.code(200).send({ attempt_id: request.params.id, status: 'closed' });
    });
    done();
  });
}

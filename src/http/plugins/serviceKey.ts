import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedError } from '../../domain/errors.js';
import type { GatewayApp } from '../types.js';
import { bearerToken } from './auth.js';

/**
 * Constant-time secret comparison. Both sides are hashed first so the compared buffers always
 * have equal length: `timingSafeEqual` throws on unequal lengths, and an early length check
 * would leak the secret's length through timing.
 */
export function secretsEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Guards backend-only routes with `Authorization: Bearer <SERVICE_API_KEY>`. */
export function registerServiceKeyAuth(scope: GatewayApp, serviceApiKey: string): void {
  scope.addHook('onRequest', (request, _reply, done) => {
    const provided = bearerToken(request);
    const ok = provided !== undefined && secretsEqual(provided, serviceApiKey);
    done(ok ? undefined : new UnauthorizedError('invalid service key'));
  });
}

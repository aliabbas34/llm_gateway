import { RateLimitedError } from '../../domain/errors.js';
import type { RateLimiter } from '../../domain/ports.js';
import type { GatewayApp } from '../types.js';
import { requireClaims } from './auth.js';

/**
 * Pipeline step 2: per-IP limit, BEFORE auth (FR4). It protects the JWT verification and
 * everything behind it from unauthenticated floods. Must be registered before the auth hook:
 * Fastify runs hooks of the same type in registration order.
 */
export function registerIpRateLimit(scope: GatewayApp, limiter: RateLimiter): void {
  scope.addHook('onRequest', async (request) => {
    const decision = await limiter.consume(request.ip);
    if (!decision.allowed) {
      throw new RateLimitedError('ip rate limit exceeded', decision.retryAfterMs / 1000);
    }
  });
}

/**
 * Pipeline step 5: per-attempt limit, AFTER auth and validation (FR4), so only well-formed,
 * authenticated requests spend the attempt's quota. `preHandler` runs after schema validation.
 */
export function registerAttemptRateLimit(scope: GatewayApp, limiter: RateLimiter): void {
  scope.addHook('preHandler', async (request) => {
    const { attemptId } = requireClaims(request);
    const decision = await limiter.consume(attemptId);
    if (!decision.allowed) {
      throw new RateLimitedError('attempt rate limit exceeded', decision.retryAfterMs / 1000);
    }
  });
}

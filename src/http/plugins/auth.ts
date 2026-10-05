import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../domain/errors.js';
import type { TokenVerifier } from '../../domain/ports.js';
import type { AttemptClaims } from '../../domain/types.js';
import type { GatewayApp } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the attempt-auth hook; null on routes without it. */
    attemptClaims: AttemptClaims | null;
  }
}

/** Extract `<token>` from `Authorization: Bearer <token>`; undefined if absent or malformed. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}

/**
 * Pipeline step 3: verify the attempt JWT (FR2) and attach its claims to the request.
 * Registered on the chat scope only; must run after the IP rate limit, before body validation.
 */
export function registerAttemptAuth(scope: GatewayApp, verifier: TokenVerifier): void {
  scope.addHook('onRequest', async (request) => {
    const token = bearerToken(request);
    if (token === undefined) throw new UnauthorizedError('missing bearer token');
    request.attemptClaims = await verifier.verify(token);
    request.log = request.log.child({ attempt_id: request.attemptClaims.attemptId });
  });
}

/** Read the claims set by the auth hook. Throwing here means a route was wired without auth: a bug. */
export function requireClaims(request: FastifyRequest): AttemptClaims {
  if (request.attemptClaims === null) {
    throw new Error('attempt auth hook did not run for this route');
  }
  return request.attemptClaims;
}

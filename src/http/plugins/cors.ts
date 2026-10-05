import cors from '@fastify/cors';
import type { GatewayApp } from '../types.js';

/**
 * CORS allowlist (NFR7). Exact origin match only, no wildcards, no credentials (auth is a bearer
 * token, not a cookie). Requests without an Origin header (curl, server-to-server) are not CORS
 * requests and pass through; they still need a valid token.
 */
export async function registerCors(
  app: GatewayApp,
  allowedOrigins: readonly string[],
): Promise<void> {
  const allow = new Set(allowedOrigins);
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, origin === undefined || allow.has(origin));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    credentials: false,
    maxAge: 600,
  });
}

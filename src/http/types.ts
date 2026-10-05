import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/** The concrete Fastify instance type used across the HTTP layer. */
export type GatewayApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

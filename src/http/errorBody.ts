import type { FastifyReply } from 'fastify';
import type { GatewayError } from '../domain/errors.js';

/**
 * The single client-facing error shape (OpenAI-like). Only generic, pre-written messages are
 * sent; internal details stay in logs, correlated by `request_id`.
 */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly request_id: string;
}

export function errorBody(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message }, request_id: requestId };
}

export function sendGatewayError(reply: FastifyReply, err: GatewayError): FastifyReply {
  if (err.retryAfterSec !== undefined) {
    void reply.header('retry-after', String(Math.max(1, Math.ceil(err.retryAfterSec))));
  }
  return reply.code(err.httpStatus).send(errorBody(err.code, err.publicMessage, reply.request.id));
}

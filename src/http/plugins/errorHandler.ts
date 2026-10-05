import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { GatewayError, ValidationError } from '../../domain/errors.js';
import { safeError } from '../../observability/safeError.js';
import { errorBody, sendGatewayError } from '../errorBody.js';
import type { GatewayApp } from '../types.js';

/**
 * Translate a thrown value into a GatewayError, or `undefined` if it is a real bug.
 *
 * Fastify's own 4xx errors (malformed JSON, unsupported media type, body too large) are client
 * mistakes; per FR3 they all surface as 400 `invalid_request` (ADR-0007 covers 413 → 400).
 */
export function toGatewayError(error: unknown): GatewayError | undefined {
  if (error instanceof GatewayError) return error;
  if (hasZodFastifySchemaValidationErrors(error)) {
    return new ValidationError('Request schema validation failed', { cause: error });
  }
  if (isFastifyClientError(error)) {
    return new ValidationError(`Fastify rejected request: ${error.code}`, { cause: error });
  }
  return undefined;
}

function isFastifyClientError(
  error: unknown,
): error is Error & { code: string; statusCode: number } {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    typeof code === 'string' &&
    code.startsWith('FST_')
  );
}

export function registerErrorHandler(app: GatewayApp): void {
  app.setErrorHandler((error, request, reply) => {
    const gwError = toGatewayError(error);
    if (gwError) {
      const level = gwError.httpStatus >= 500 ? 'warn' : 'info';
      // Expected failures: log-safe summary only (a JSON parse cause would quote the body).
      request.log[level](
        { error: safeError(gwError), code: gwError.code, status: gwError.httpStatus },
        'request rejected',
      );
      return sendGatewayError(reply, gwError);
    }
    // A real bug: keep the full error and stack. Messages here come from code, not request data.
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send(errorBody('internal_error', 'An internal error occurred.', request.id));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody('not_found', 'Not found.', request.id)),
  );
}

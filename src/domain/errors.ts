/**
 * Error taxonomy.
 *
 * Every *expected* failure is a `GatewayError` subclass that carries:
 * - `code`: stable machine-readable identifier sent to clients;
 * - `httpStatus`: the only place HTTP semantics are decided;
 * - `publicMessage`: a generic, safe message for the response body.
 * The constructor `message` / `cause` are for logs only and never reach clients.
 *
 * Anything that is *not* a GatewayError is a bug and becomes a 500.
 */
export abstract class GatewayError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: 400 | 401 | 403 | 429 | 502 | 503;
  abstract readonly publicMessage: string;
  /** Seconds the client should wait before retrying (sent as Retry-After). */
  readonly retryAfterSec: number | undefined;

  constructor(message: string, options?: { cause?: unknown; retryAfterSec?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.retryAfterSec = options?.retryAfterSec;
  }
}

export class ValidationError extends GatewayError {
  readonly code = 'invalid_request';
  readonly httpStatus = 400;
  readonly publicMessage = 'The request is invalid.';
}

export class UnauthorizedError extends GatewayError {
  readonly code = 'unauthorized';
  readonly httpStatus = 401;
  readonly publicMessage = 'Missing, invalid or expired credentials.';
}

export class AttemptClosedError extends GatewayError {
  readonly code = 'attempt_closed';
  readonly httpStatus = 403;
  readonly publicMessage = 'This attempt is closed.';
}

/** ADR-0006: 403, because retrying cannot make an exhausted allowance useful again. */
export class BudgetExhaustedError extends GatewayError {
  readonly code = 'budget_exhausted';
  readonly httpStatus = 403;
  readonly publicMessage = 'The token allowance for this attempt is used up.';
}

export class RateLimitedError extends GatewayError {
  readonly code = 'rate_limited';
  readonly httpStatus = 429;
  readonly publicMessage = 'Too many requests. Retry later.';

  constructor(message: string, retryAfterSec: number) {
    super(message, { retryAfterSec });
  }
}

/** Every candidate provider failed before the first byte was sent. */
export class UpstreamUnavailableError extends GatewayError {
  readonly code = 'upstream_unavailable';
  readonly httpStatus = 502;
  readonly publicMessage = 'The model provider is unavailable. Retry later.';
}

/** A dependency we cannot safely operate without (Redis) is down: fail closed. */
export class DependencyUnavailableError extends GatewayError {
  readonly code = 'service_unavailable';
  readonly httpStatus = 503;
  readonly publicMessage = 'The service is temporarily unavailable. Retry later.';

  constructor(message: string, options?: { cause?: unknown; retryAfterSec?: number }) {
    super(message, { retryAfterSec: 1, ...options });
  }
}

export class ShuttingDownError extends GatewayError {
  readonly code = 'shutting_down';
  readonly httpStatus = 503;
  readonly publicMessage = 'The service is restarting. Retry shortly.';

  constructor() {
    super('Instance is draining', { retryAfterSec: 1 });
  }
}

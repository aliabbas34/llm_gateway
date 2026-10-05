import { describe, expect, it } from 'vitest';
import {
  AttemptClosedError,
  BudgetExhaustedError,
  DependencyUnavailableError,
  GatewayError,
  RateLimitedError,
  ShuttingDownError,
  UnauthorizedError,
  UpstreamUnavailableError,
  ValidationError,
} from '../../../src/domain/errors.js';

describe('error taxonomy', () => {
  it.each([
    [new ValidationError('x'), 400, 'invalid_request'],
    [new UnauthorizedError('x'), 401, 'unauthorized'],
    [new AttemptClosedError('x'), 403, 'attempt_closed'],
    [new BudgetExhaustedError('x'), 403, 'budget_exhausted'],
    [new RateLimitedError('x', 3), 429, 'rate_limited'],
    [new UpstreamUnavailableError('x'), 502, 'upstream_unavailable'],
    [new DependencyUnavailableError('x'), 503, 'service_unavailable'],
    [new ShuttingDownError(), 503, 'shutting_down'],
  ] as const)('%o maps to %i / %s', (err, status, code) => {
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.httpStatus).toBe(status);
    expect(err.code).toBe(code);
    expect(err.name).toBe(err.constructor.name);
  });

  it('keeps internal detail out of the public message', () => {
    const err = new ValidationError('message 3 has 40000 chars');
    expect(err.publicMessage).not.toContain('40000');
  });

  it('carries Retry-After for rate limits and fail-closed errors', () => {
    expect(new RateLimitedError('x', 7).retryAfterSec).toBe(7);
    expect(new DependencyUnavailableError('x').retryAfterSec).toBe(1);
    expect(new DependencyUnavailableError('x', { retryAfterSec: 5 }).retryAfterSec).toBe(5);
    expect(new ValidationError('x').retryAfterSec).toBeUndefined();
  });

  it('preserves the cause for logs', () => {
    const cause = new Error('ECONNREFUSED');
    expect(new DependencyUnavailableError('redis down', { cause }).cause).toBe(cause);
  });
});

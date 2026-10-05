import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimiter } from '../../domain/ports.js';
import { failClosed } from './failClosed.js';

export interface RateLimitPolicy {
  readonly limit: number;
  readonly periodMs: number;
}

/**
 * GCRA rate limiter in Redis (strategy: lua/rate_limit_gcra.lua). Exact Retry-After, bursts up to
 * `limit`, one key per subject, atomic under any concurrency, shared across all instances.
 * Redis failure → 503 via failClosed: an unenforceable limit must not become "no limit" (NFR5).
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly policy: RateLimitPolicy,
    private readonly keyFor: (subject: string) => string,
  ) {}

  async consume(subject: string): Promise<RateLimitDecision> {
    const [allowed, retryAfterMs] = await failClosed('rate limit', () =>
      this.redis.gwRateLimit(this.keyFor(subject), this.policy.limit, this.policy.periodMs),
    );
    return { allowed: allowed === 1, retryAfterMs };
  }
}

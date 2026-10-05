import { readFileSync } from 'node:fs';
import type { Redis, Result } from 'ioredis';

/**
 * Lua scripts registered as ioredis custom commands (`defineCommand`): EVALSHA with automatic
 * EVAL fallback on NOSCRIPT. Each script touches only the keys it declares, and every declared key
 * of one call shares a hash slot (redisKeys), so the scripts are Redis Cluster safe.
 */
declare module 'ioredis' {
  interface RedisCommander<Context> {
    /** → [allowed 1|0, retryAfterMs] */
    gwRateLimit(key: string, limit: number, periodMs: number): Result<[number, number], Context>;
    /** KEYS: status, budget, reservations. See lua/reserve.lua. */
    gwReserve(
      statusKey: string,
      budgetKey: string,
      reservationsKey: string,
      ...args: (string | number)[]
    ): Result<(string | number)[], Context>;
    /** KEYS: budget, reservations. See lua/settle.lua. */
    gwSettle(
      budgetKey: string,
      reservationsKey: string,
      reservationId: string,
      actualTokens: number,
    ): Result<(string | number)[], Context>;
    /** KEYS: reservations. See lua/claim_expired.lua. */
    gwClaimExpired(
      reservationsKey: string,
      reservationId: string,
    ): Result<(string | number)[], Context>;
  }
}

function lua(file: string): string {
  // Resolved relative to this module, so it works from src/ (tsx, vitest) and dist/ (copied at build).
  return readFileSync(new URL(`./lua/${file}`, import.meta.url), 'utf8');
}

/** Register all gateway scripts on a client. Idempotent per client; performs no I/O on Redis. */
export function defineGatewayCommands(redis: Redis): Redis {
  redis.defineCommand('gwRateLimit', { numberOfKeys: 1, lua: lua('rate_limit_gcra.lua') });
  redis.defineCommand('gwReserve', { numberOfKeys: 3, lua: lua('reserve.lua') });
  redis.defineCommand('gwSettle', { numberOfKeys: 2, lua: lua('settle.lua') });
  redis.defineCommand('gwClaimExpired', { numberOfKeys: 1, lua: lua('claim_expired.lua') });
  return redis;
}

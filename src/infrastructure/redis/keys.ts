import { ATTEMPT_ID_PATTERN } from '../../domain/types.js';

/**
 * The only place Redis key strings are built.
 *
 * Per-attempt keys share the hash tag `{att:<id>}`, so in Redis Cluster they live in one slot and
 * a single Lua script may touch all of them atomically. The reservation-expiry index is global (its
 * own slot) and is never touched inside a per-attempt script (ADR-0005).
 */
const PREFIX = 'gw';

function attemptTag(attemptId: string): string {
  // Defence in depth: ids are validated at the edge, but a bad id here would corrupt key space.
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error('invalid attempt id for redis key');
  return `${PREFIX}:{att:${attemptId}}`;
}

export const redisKeys = {
  budget: (attemptId: string) => `${attemptTag(attemptId)}:budget`,
  status: (attemptId: string) => `${attemptTag(attemptId)}:status`,
  reservations: (attemptId: string) => `${attemptTag(attemptId)}:resv`,
  attemptRate: (attemptId: string) => `${attemptTag(attemptId)}:rl`,
  ipRate: (ip: string) => `${PREFIX}:rl:ip:${ip}`,
  reservationExpiry: `${PREFIX}:resv:expiry`,
} as const;

export const ATTEMPT_CLOSED = 'closed';

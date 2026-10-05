import type { Redis } from 'ioredis';
import type { AttemptStatusStore } from '../../domain/ports.js';
import { failClosed } from './failClosed.js';
import { ATTEMPT_CLOSED, redisKeys } from './keys.js';

/**
 * Writes the closed flag that the reserve script checks. A single SET is atomic and naturally
 * idempotent (closing twice leaves the same state), so no Lua is needed.
 */
export class RedisAttemptStatusStore implements AttemptStatusStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec: number,
  ) {}

  async close(attemptId: string): Promise<void> {
    await failClosed('close attempt', () =>
      this.redis.set(redisKeys.status(attemptId), ATTEMPT_CLOSED, 'EX', this.ttlSec),
    );
  }
}

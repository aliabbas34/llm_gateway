import type { Redis } from 'ioredis';
import type { HealthCheck } from '../../domain/ports.js';

export class RedisHealthCheck implements HealthCheck {
  readonly name = 'redis';

  constructor(private readonly redis: Redis) {}

  async check(): Promise<void> {
    await this.redis.ping();
  }
}

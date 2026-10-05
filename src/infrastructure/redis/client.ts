import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Config } from '../../config/loadConfig.js';
import { defineGatewayCommands } from './commands.js';

/**
 * ioredis tuned to FAIL CLOSED (NFR5) instead of hanging:
 * - `enableOfflineQueue: false`: while disconnected, commands reject immediately rather than queue.
 * - `maxRetriesPerRequest: 1` + `commandTimeout`: a slow or dead Redis surfaces as an error quickly.
 * - `retryStrategy`: the *connection* keeps reconnecting in the background with capped backoff,
 *   so the instance recovers by itself once Redis is back.
 * - `lazyConnect`: constructing the client performs no I/O; the composition root calls connect().
 * The gateway Lua scripts are registered as custom commands on every client.
 */
export function createRedisClient(config: Pick<Config, 'redis'>, logger: Logger): Redis {
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: config.redis.commandTimeoutMs,
    connectTimeout: 2_000,
    enableAutoPipelining: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });
  redis.on('error', (err: Error) => {
    logger.warn({ err: { message: err.message, name: err.name } }, 'redis connection error');
  });
  return defineGatewayCommands(redis);
}

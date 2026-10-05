import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { Config } from '../config/loadConfig.js';

/**
 * Structured JSON logging.
 *
 * Primary defence for NFR9 ("never log prompt or completion text") is that no code path passes
 * message content to the logger: request/response bodies are never serialized, and provider
 * error bodies are never attached to errors. Redaction below is defence in depth for fields that
 * could carry secrets or content if someone adds a careless log call later.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-service-key"]',
  'headers.authorization',
  'authorization',
  'token',
  'apiKey',
  '*.apiKey',
  'body',
  '*.body',
  'messages',
  '*.messages',
  'content',
  '*.content',
  'prompt',
  '*.prompt',
  'completion',
  '*.completion',
] as const;

export function loggerOptions(config: Pick<Config, 'log'>): LoggerOptions {
  return {
    level: config.log.level,
    base: { service: 'llm-gateway' },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    formatters: {
      // Emit the level as a string ("info") rather than pino's number (30).
      level: (label) => ({ level: label }),
    },
  };
}

/** Create the root logger. Tests pass `destination` to capture output. */
export function createLogger(config: Pick<Config, 'log'>, destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(config), destination) : pino(loggerOptions(config));
}

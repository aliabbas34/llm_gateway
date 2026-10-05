import { loadConfig, type Config } from '../../src/config/loadConfig.js';
import { TEST_PUBLIC_KEY_PEM } from './testKeys.js';

/** Real infrastructure for integration tests (docker compose locally, service containers in CI). */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://gateway:gateway@localhost:5433/gateway';
export const TEST_SERVICE_API_KEY = 'test-service-key-0123456789abcdef0123456789';

/** Minimal valid env for tests; override per test. */
export const baseTestEnv: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  REDIS_URL: TEST_REDIS_URL,
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_PUBLIC_KEY: TEST_PUBLIC_KEY_PEM,
  SERVICE_API_KEY: TEST_SERVICE_API_KEY,
};

export function testConfig(overrides: Readonly<Record<string, string>> = {}): Config {
  return loadConfig({ ...baseTestEnv, ...overrides });
}

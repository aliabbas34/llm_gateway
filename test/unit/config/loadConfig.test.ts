import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/loadConfig.js';
import { TEST_PUBLIC_KEY_PEM } from '../../helpers/testKeys.js';

/** Only the variables without defaults. */
const required = {
  REDIS_URL: 'redis://localhost:6380',
  DATABASE_URL: 'postgres://u:p@localhost:5433/db',
  JWT_PUBLIC_KEY: TEST_PUBLIC_KEY_PEM,
  SERVICE_API_KEY: 'k'.repeat(32),
};

function issuesOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies safe defaults when only required variables are set', () => {
    const c = loadConfig(required);
    expect(c.env).toBe('production');
    expect(c.http).toEqual({
      host: '0.0.0.0',
      port: 8080,
      trustProxyHops: 0,
      corsAllowedOrigins: [],
    });
    expect(c.log.level).toBe('info');
    expect(c.shutdown.drainTimeoutMs).toBe(25_000);
    expect(c.redis.commandTimeoutMs).toBe(500);
    expect(c.postgres).toMatchObject({ poolMax: 10, statementTimeoutMs: 2_000 });
    expect(c.auth.clockToleranceSec).toBe(5);
    expect(c.attempts.ttlSec).toBe(30 * 24 * 3600);
  });

  it('requires every secret / connection variable', () => {
    const msg = issuesOf({});
    for (const name of Object.keys(required)) expect(msg).toContain(name);
  });

  it('coerces numbers and splits CSV lists', () => {
    const c = loadConfig({
      ...required,
      PORT: '9000',
      TRUST_PROXY_HOPS: '1',
      CORS_ALLOWED_ORIGINS: ' https://a.example , https://b.example ,,',
    });
    expect(c.http.port).toBe(9000);
    expect(c.http.trustProxyHops).toBe(1);
    expect(c.http.corsAllowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('accepts a one-line PEM with literal \\n escapes', () => {
    const oneLine = TEST_PUBLIC_KEY_PEM.replace(/\n/g, '\\n');
    expect(loadConfig({ ...required, JWT_PUBLIC_KEY: oneLine }).auth.jwtPublicKeyPem).toBe(
      TEST_PUBLIC_KEY_PEM.trim(),
    );
  });

  it.each([
    ['REDIS_URL', 'http://localhost:6379'],
    ['DATABASE_URL', 'not a url'],
    ['JWT_PUBLIC_KEY', 'hello'],
    ['SERVICE_API_KEY', 'short'],
    ['PORT', 'not-a-port'],
    ['LOG_LEVEL', 'loud'],
  ])('rejects an invalid %s', (name, value) => {
    expect(issuesOf({ ...required, [name]: value })).toContain(name);
  });

  it('does not echo variable values in error messages (they may be secrets)', () => {
    const msg = issuesOf({ ...required, SERVICE_API_KEY: 'super-secret-but-short' });
    expect(msg).toContain('SERVICE_API_KEY');
    expect(msg).not.toContain('super-secret-but-short');
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '../../../src/infrastructure/auth/JwtTokenVerifier.js';
import { registerAttemptAuth, requireClaims } from '../../../src/http/plugins/auth.js';
import type { GatewayApp } from '../../../src/http/types.js';
import { buildTestApp, type TestApp } from '../../helpers/testApp.js';
import { TEST_PUBLIC_KEY_PEM } from '../../helpers/testKeys.js';
import { testToken, untrustedToken } from '../../helpers/tokens.js';

let verifier: JwtTokenVerifier;
let t: TestApp | undefined;

beforeAll(async () => {
  verifier = await JwtTokenVerifier.fromPem(TEST_PUBLIC_KEY_PEM, { clockToleranceSec: 0 });
});
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

/** A test app with one protected route echoing the attempt id, and one unprotected route. */
async function appWithProtectedRoute(): Promise<TestApp> {
  const ta = await buildTestApp();
  await ta.app.register((scope: GatewayApp, _opts, done) => {
    registerAttemptAuth(scope, verifier);
    scope.get('/protected', (req) => ({ attempt: requireClaims(req).attemptId }));
    done();
  });
  ta.app.get('/unprotected', (req) => ({ attempt: requireClaims(req).attemptId }));
  return ta;
}

const get = (url: string, token?: string) => ({
  method: 'GET' as const,
  url,
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
});

describe('attempt auth hook (FR2)', () => {
  it('attaches verified claims for a valid token', async () => {
    t = await appWithProtectedRoute();
    const res = await t.app.inject(get('/protected', await testToken({ attemptId: 'att-5' })));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ attempt: 'att-5' });
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'definitely-not-a-jwt'],
  ])('returns 401 for a %s token', async (_label, token) => {
    t = await appWithProtectedRoute();
    const res = await t.app.inject(get('/protected', token));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('returns 401 for expired and untrusted tokens', async () => {
    t = await appWithProtectedRoute();
    expect(
      (await t.app.inject(get('/protected', await testToken({ ttlSec: -1 })))).statusCode,
    ).toBe(401);
    expect((await t.app.inject(get('/protected', await untrustedToken()))).statusCode).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    t = await appWithProtectedRoute();
    const token = await testToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Basic ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never logs the token', async () => {
    t = await appWithProtectedRoute();
    const token = await testToken({ ttlSec: -1 });
    await t.app.inject(get('/protected', token));
    expect(t.logs.text).not.toContain(token);
    expect(t.logs.text).not.toContain(token.split('.')[2]);
  });

  it('requireClaims on a route without auth is a bug (500), not a silent pass', async () => {
    t = await appWithProtectedRoute();
    const res = await t.app.inject(get('/unprotected', await testToken()));
    expect(res.statusCode).toBe(500);
  });
});

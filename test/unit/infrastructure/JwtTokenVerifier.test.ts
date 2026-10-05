import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedError } from '../../../src/domain/errors.js';
import { JwtTokenVerifier } from '../../../src/infrastructure/auth/JwtTokenVerifier.js';
import { importPrivateKey } from '../../../scripts/lib/tokens.js';
import { TEST_PRIVATE_KEY_PEM, TEST_PUBLIC_KEY_PEM } from '../../helpers/testKeys.js';
import { testToken, untrustedToken } from '../../helpers/tokens.js';

let verifier: JwtTokenVerifier;
beforeAll(async () => {
  verifier = await JwtTokenVerifier.fromPem(TEST_PUBLIC_KEY_PEM, { clockToleranceSec: 0 });
});

async function rejection(token: string): Promise<UnauthorizedError> {
  const err = await verifier.verify(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnauthorizedError);
  return err as UnauthorizedError;
}

describe('JwtTokenVerifier (FR2)', () => {
  it('accepts a valid token and maps claims', async () => {
    const claims = await verifier.verify(
      await testToken({ attemptId: 'att-42', studentId: 'stu-7', tokenBudget: 900 }),
    );
    expect(claims).toMatchObject({
      attemptId: 'att-42',
      studentId: 'stu-7',
      tokenBudget: 900,
      maxTokensCap: 512,
    });
    expect(claims.expiresAtSec).toBeGreaterThan(Date.now() / 1000);
  });

  it('rejects an expired token', async () => {
    const err = await rejection(await testToken({ ttlSec: -60 }));
    expect(err.message).toContain('ERR_JWT_EXPIRED');
  });

  it('rejects the wrong audience', async () => {
    const err = await rejection(await testToken({ audience: 'some-other-service' }));
    expect(err.message).toContain('ERR_JWT_CLAIM_VALIDATION_FAILED');
  });

  it('rejects a token signed by an untrusted key', async () => {
    const err = await rejection(await untrustedToken());
    expect(err.message).toContain('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
  });

  it('rejects a symmetric (HS256) token: algorithm confusion is impossible', async () => {
    const hs = await new SignJWT({ attempt_id: 'a', max_tokens_cap: 1, token_budget: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('s')
      .setAudience('llm-gateway')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(TEST_PUBLIC_KEY_PEM));
    const err = await rejection(hs);
    expect(err.message).toContain('ERR_JOSE_ALG_NOT_ALLOWED');
  });

  it('rejects garbage', async () => {
    await rejection('not.a.jwt');
    await rejection('');
  });

  it('rejects missing or malformed custom claims, without echoing values', async () => {
    const key = await importPrivateKey(TEST_PRIVATE_KEY_PEM);
    const bad = await new SignJWT({ attempt_id: 'bad id with spaces', token_budget: -5 })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('stu')
      .setAudience('llm-gateway')
      .setExpirationTime('5m')
      .sign(key);
    const err = await rejection(bad);
    expect(err.message).toContain('attempt_id');
    expect(err.message).toContain('max_tokens_cap');
    expect(err.message).toContain('token_budget');
    expect(err.message).not.toContain('bad id with spaces');
  });

  it('rejects a token without exp', async () => {
    const key = await importPrivateKey(TEST_PRIVATE_KEY_PEM);
    const noExp = await new SignJWT({ attempt_id: 'a', max_tokens_cap: 1, token_budget: 1 })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('stu')
      .setAudience('llm-gateway')
      .sign(key);
    await rejection(noExp);
  });
});

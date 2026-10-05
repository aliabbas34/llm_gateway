/**
 * Simulates the product backend's token issuance. Shared by the dev scripts and the tests, so
 * there is exactly one definition of what an attempt token looks like.
 */
import {
  SignJWT,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  type CryptoKey,
} from 'jose';

export const AUDIENCE = 'llm-gateway';

export interface MintOptions {
  readonly studentId: string;
  readonly attemptId: string;
  readonly tokenBudget: number;
  readonly maxTokensCap: number;
  /** Lifetime in seconds (default 15 minutes). Negative values mint an already-expired token. */
  readonly ttlSec?: number;
  readonly audience?: string;
}

export async function generateEd25519KeyPair(): Promise<{ privatePem: string; publicPem: string }> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return { privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) };
}

export async function importPrivateKey(privatePem: string): Promise<CryptoKey> {
  return importPKCS8(privatePem, 'EdDSA');
}

export async function mintAttemptToken(privateKey: CryptoKey, o: MintOptions): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    attempt_id: o.attemptId,
    max_tokens_cap: o.maxTokensCap,
    token_budget: o.tokenBudget,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setSubject(o.studentId)
    .setAudience(o.audience ?? AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (o.ttlSec ?? 15 * 60))
    .sign(privateKey);
}

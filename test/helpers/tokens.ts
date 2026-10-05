import { importPrivateKey, mintAttemptToken, type MintOptions } from '../../scripts/lib/tokens.js';
import { OTHER_PRIVATE_KEY_PEM, TEST_PRIVATE_KEY_PEM } from './testKeys.js';

const defaults: MintOptions = {
  studentId: 'stu-1',
  attemptId: 'att-1',
  tokenBudget: 10_000,
  maxTokensCap: 512,
};

/** Mint a token signed with the test key the gateway trusts. */
export async function testToken(overrides: Partial<MintOptions> = {}): Promise<string> {
  return mintAttemptToken(await importPrivateKey(TEST_PRIVATE_KEY_PEM), {
    ...defaults,
    ...overrides,
  });
}

/** Mint a token signed with a key the gateway does NOT trust. */
export async function untrustedToken(overrides: Partial<MintOptions> = {}): Promise<string> {
  return mintAttemptToken(await importPrivateKey(OTHER_PRIVATE_KEY_PEM), {
    ...defaults,
    ...overrides,
  });
}

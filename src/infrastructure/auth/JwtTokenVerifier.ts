import { errors as joseErrors, importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { z } from 'zod';
import { UnauthorizedError } from '../../domain/errors.js';
import type { TokenVerifier } from '../../domain/ports.js';
import { ATTEMPT_ID_PATTERN, type AttemptClaims } from '../../domain/types.js';

export const JWT_AUDIENCE = 'llm-gateway';
const ALGORITHM = 'EdDSA';

/** Claims beyond the registered ones; validated after the signature is known to be good. */
const claimsSchema = z.object({
  sub: z.string().min(1).max(128),
  attempt_id: z.string().regex(ATTEMPT_ID_PATTERN),
  exp: z.number().int(),
  max_tokens_cap: z.number().int().positive().max(1_000_000),
  token_budget: z.number().int().positive().max(1_000_000_000),
});

export interface JwtVerifierOptions {
  readonly clockToleranceSec: number;
}

/**
 * Verifies attempt tokens: EdDSA signature (public key only), `aud`, `exp`, then claim shapes.
 *
 * Every failure becomes an UnauthorizedError (401) whose *internal* message names the reason
 * (e.g. ERR_JWT_EXPIRED) for logs. The token itself is never included anywhere.
 */
export class JwtTokenVerifier implements TokenVerifier {
  private constructor(
    private readonly key: CryptoKey,
    private readonly options: JwtVerifierOptions,
  ) {}

  static async fromPem(spkiPem: string, options: JwtVerifierOptions): Promise<JwtTokenVerifier> {
    return new JwtTokenVerifier(await importSPKI(spkiPem, ALGORITHM), options);
  }

  async verify(token: string): Promise<AttemptClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        audience: JWT_AUDIENCE,
        clockTolerance: this.options.clockToleranceSec,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (err) {
      const reason = err instanceof joseErrors.JOSEError ? err.code : 'ERR_UNKNOWN';
      throw new UnauthorizedError(`token rejected: ${reason}`);
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      const fields = claims.error.issues.map((i) => i.path.join('.')).join(',');
      throw new UnauthorizedError(`token claims invalid: ${fields}`);
    }
    const c = claims.data;
    return {
      studentId: c.sub,
      attemptId: c.attempt_id,
      maxTokensCap: c.max_tokens_cap,
      tokenBudget: c.token_budget,
      expiresAtSec: c.exp,
    };
  }
}

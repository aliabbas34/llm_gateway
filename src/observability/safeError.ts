import { GatewayError } from '../domain/errors.js';
import { ProviderError } from '../domain/providerErrors.js';

/**
 * A log-safe view of an error (NFR9).
 *
 * Third-party error messages can embed request data. The clearest case: V8's JSON.parse errors
 * quote the start of the invalid input, so a malformed chat body would put prompt text into a
 * log line. So:
 * - our own errors (GatewayError, ProviderError) keep their message: we wrote it, it holds no content;
 * - for everything else only `name` and `code` survive;
 * - the cause chain is followed (a few levels deep) under the same rules.
 */
export interface SafeError {
  readonly name: string;
  readonly code?: string;
  readonly message?: string;
  readonly kind?: string;
  readonly status?: number;
  readonly cause?: SafeError;
}

const MAX_DEPTH = 4;

export function safeError(err: unknown, depth = 0): SafeError {
  if (!(err instanceof Error)) return { name: typeof err };
  const code = (err as { code?: unknown }).code;
  const base: SafeError = {
    name: err.name,
    ...(typeof code === 'string' && { code }),
    ...((err instanceof GatewayError || err instanceof ProviderError) && { message: err.message }),
    ...(err instanceof ProviderError && {
      kind: err.kind,
      ...(err.status !== undefined && { status: err.status }),
    }),
  };
  if (err.cause !== undefined && depth < MAX_DEPTH) {
    return { ...base, cause: safeError(err.cause, depth + 1) };
  }
  return base;
}

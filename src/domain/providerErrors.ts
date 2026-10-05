/**
 * Classified provider failures. Every adapter (including the fake) must map failures to the same
 * kinds; the shared contract suite enforces it (LSP). Failover policy depends only on `kind`.
 *
 * Messages carry status codes and error classes, never upstream response bodies: a body can echo
 * the prompt (NFR9).
 */
export const PROVIDER_ERROR_KINDS = [
  'rate_limited', // HTTP 429
  'server_error', // HTTP 5xx, or an error object inside the stream
  'timeout', // TTFT / idle timeout, or HTTP 408
  'connection', // DNS, refused, reset, TLS: no usable HTTP response
  'client_error', // other 4xx: our request or our credentials are wrong
  'protocol_error', // malformed SSE / JSON, stream ended without [DONE]
  'aborted', // we cancelled (client disconnect, shutdown): not the provider's fault
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** FR6: kinds that may fail over to the next model (only before the first byte). */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'server_error',
  'timeout',
  'connection',
]);

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterSec?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options?.status;
    this.retryAfterSec = options?.retryAfterSec;
  }

  readonly status: number | undefined;
  readonly retryAfterSec: number | undefined;

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Map an upstream HTTP status to an error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server_error';
  return 'client_error';
}

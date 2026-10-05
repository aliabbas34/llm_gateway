import type {
  AttemptClaims,
  ChatChunk,
  ChatMessage,
  ModelRef,
  ProviderRequest,
  UsageEntry,
} from './types.js';

/**
 * Ports: the small interfaces the core depends on. Adapters in `infrastructure/` implement them;
 * tests substitute in-memory fakes. Each port exists because it is an I/O boundary or a test seam.
 */

/** Time source for *local* measurements (latency, TTFT). Cross-instance time comes from Redis (ADR-0003). */
export interface Clock {
  /** Wall-clock epoch milliseconds. */
  nowMs(): number;
  /** Monotonic milliseconds; only differences are meaningful. */
  monotonicMs(): number;
}

export interface IdGenerator {
  next(): string;
}

/** A dependency whose reachability decides `/readyz`. */
export interface HealthCheck {
  readonly name: string;
  /** Resolves when healthy; rejects (or times out) when not. */
  check(signal: AbortSignal): Promise<void>;
}

/** Verifies an attempt token. Rejects with UnauthorizedError for any invalid token. */
export interface TokenVerifier {
  verify(token: string): Promise<AttemptClaims>;
}

/**
 * Attempt open/closed state (FR7). Absent means open. Only *writes* go through this port: the
 * closed check happens atomically inside the budget reserve script, so there is no separate read.
 */
export interface AttemptStatusStore {
  /** Idempotent: closing a closed attempt is a no-op. */
  close(attemptId: string): Promise<void>;
}

/** Append-only usage ledger (FR8). Idempotent per requestId. Writes a batch of rows at once. */
export interface UsageLedger {
  record(entries: readonly UsageEntry[]): Promise<void>;
}

/**
 * A chat model provider.
 *
 * Contract (verified by test/contract for every adapter):
 * - yields normalized ChatChunks in order; returns when the upstream stream completes;
 * - every failure is thrown as a ProviderError with a classified `kind`;
 * - aborting `signal` stops the upstream request and throws ProviderError('aborted');
 * - a response body that is not fully consumed is cancelled (no leaked sockets).
 */
export interface LlmProvider {
  readonly name: string;
  streamChat(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Estimates token counts locally (used for reservations and when providers omit usage). */
export interface TokenCounter {
  countMessages(messages: readonly ChatMessage[]): number;
  countText(text: string): number;
}

/** A model ready to call: the adapter plus the vendor's model id. */
export interface ResolvedModel {
  readonly ref: ModelRef;
  readonly provider: LlmProvider;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** When denied: how long until one more request would be allowed. 0 when allowed. */
  readonly retryAfterMs: number;
}

/**
 * Counts one request against a subject (an IP, an attempt id) under a fixed policy.
 * One instance per policy; the algorithm is the adapter's strategy.
 */
export interface RateLimiter {
  consume(subject: string): Promise<RateLimitDecision>;
}

// --- Budget (FR5) ---------------------------------------------------------------------------

export interface ReserveRequest {
  readonly attemptId: string;
  /** Unique per request (the request id). Identifies the reservation in reconcile/release. */
  readonly reservationId: string;
  readonly studentId: string;
  /** From the token; used only if the attempt has no budget yet (SETNX). */
  readonly initialBudget: number;
  readonly maxTokensCap: number;
  readonly inputTokens: number;
}

export type ReserveResult =
  | {
      readonly status: 'reserved';
      /** input + effective: the most this request can ever be charged. */
      readonly reservedTokens: number;
      /** min(max_tokens_cap, remaining − input): sent to the provider as max_tokens. */
      readonly effectiveMaxTokens: number;
    }
  | { readonly status: 'attempt_closed' }
  | { readonly status: 'budget_exhausted'; readonly remainingTokens: number };

export type SettleResult =
  | {
      readonly status: 'settled';
      readonly reservedTokens: number;
      readonly chargedTokens: number;
      readonly remainingTokens: number;
    }
  /** Someone already settled it (a retry, or the sweeper after expiry). A no-op. */
  | { readonly status: 'already_settled' };

/** An abandoned reservation the sweeper claimed and charged in full. */
export interface ExpiredReservation {
  readonly attemptId: string;
  readonly reservationId: string;
  readonly studentId: string;
  readonly inputTokens: number;
  readonly reservedTokens: number;
  readonly ageMs: number;
}

/**
 * Remaining-token accounting for attempts. Every method is atomic per attempt.
 * Invariant: remaining + Σ open reservations + Σ charged = initial budget, and remaining ≥ 0.
 */
export interface BudgetStore {
  reserve(request: ReserveRequest): Promise<ReserveResult>;
  /** Charge min(actualTokens, reserved), refund the rest. Idempotent. */
  reconcile(attemptId: string, reservationId: string, actualTokens: number): Promise<SettleResult>;
  /** Refund everything (nothing was consumed). Idempotent. */
  release(attemptId: string, reservationId: string): Promise<SettleResult>;
  /** Claim up to `limit` expired reservations, charging each in full. Safe across instances. */
  sweepExpired(limit: number): Promise<ExpiredReservation[]>;
}

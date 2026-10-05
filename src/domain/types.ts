/**
 * Core domain types. Plain data, no behaviour, no library types.
 */

/** Attempt ids become part of Redis keys, so they are restricted to a safe alphabet. */
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Verified JWT claims (see SPEC §3). Field names are camelCase versions of the claim names. */
export interface AttemptClaims {
  readonly studentId: string;
  readonly attemptId: string;
  readonly maxTokensCap: number;
  readonly tokenBudget: number;
  readonly expiresAtSec: number;
}

export const OUTCOMES = [
  'completed',
  'client_disconnected',
  'upstream_error',
  'stream_error',
  'budget_exhausted',
  'attempt_closed',
  'shutdown_aborted',
  'expired_unreconciled',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** One usage-ledger row (FR8). */
export interface UsageEntry {
  readonly requestId: string;
  readonly attemptId: string;
  readonly studentId: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservedTokens: number;
  readonly chargedTokens: number;
  readonly outcome: Outcome;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  readonly failoverCount: number;
}

// --- Chat ---------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
}

/** A model is always addressed through the provider that serves it, e.g. `groq:llama-3.3-70b`. */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

/** What the gateway asks a provider for. Provider-agnostic; adapters translate it. */
export interface ProviderRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The single normalized stream element every provider adapter produces. Vendor differences
 * (where usage lives, role-only first deltas, legacy fields) are absorbed by the adapters.
 */
export type ChatChunk =
  | { readonly type: 'delta'; readonly content: string }
  | { readonly type: 'finish'; readonly reason: string }
  | { readonly type: 'usage'; readonly usage: Usage };

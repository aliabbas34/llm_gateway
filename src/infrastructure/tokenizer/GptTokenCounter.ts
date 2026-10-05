import { countTokens } from 'gpt-tokenizer';
import type { TokenCounter } from '../../domain/ports.js';
import type { ChatMessage } from '../../domain/types.js';

/** Chat-format overhead per message (role + delimiters) and per reply, as in OpenAI's guidance. */
const TOKENS_PER_MESSAGE = 4;
const TOKENS_PER_REPLY_PRIMING = 3;

/**
 * BPE cost is quadratic in the length of a single pre-token: 32,000 identical characters take ~4 s
 * of blocking CPU, which would let one request freeze the event loop. Tokenizing in bounded chunks
 * makes the cost linear. The price is a slight overcount at chunk boundaries (~0.5 % on normal
 * text), which errs in the safe direction (ADR-0008).
 */
const CHUNK_CHARS = 512;

/**
 * Local token estimate (ADR-0008) with the o200k BPE (gpt-tokenizer, pure JS, no WASM).
 *
 * Providers use different tokenizers (Llama 3, Mistral), so this is an *estimate*. The multiplier
 * biases it upward. The budget's hard limit doesn't depend on its accuracy: the provider gets
 * `max_tokens = effective`, and reconcile charges min(actual, reserved).
 */
export class GptTokenCounter implements TokenCounter {
  constructor(private readonly multiplier: number) {}

  countMessages(messages: readonly ChatMessage[]): number {
    let raw = TOKENS_PER_REPLY_PRIMING;
    for (const m of messages) raw += TOKENS_PER_MESSAGE + countChunked(m.content);
    return Math.ceil(raw * this.multiplier);
  }

  countText(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(countChunked(text) * this.multiplier);
  }
}

function countChunked(text: string): number {
  let total = 0;
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    // Never split a UTF-16 surrogate pair (emoji etc.) across chunks.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    total += countTokens(text.slice(start, end));
    start = end;
  }
  return total;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

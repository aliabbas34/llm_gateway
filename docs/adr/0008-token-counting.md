# ADR-0008: Local token counting — chunked o200k BPE with a safety multiplier

- Status: accepted
- Date: 2026-10-03

## Context

FR5 reserves `input + effective` tokens **before** calling a provider, so the gateway must
estimate input tokens locally. It must also count output tokens when a provider omits usage, or
when the client disconnects (no final usage chunk). Groq serves Llama models and Mistral its own;
neither tokenizer ships as a fast pure-JS library, and they differ from each other.

## Decision

1. `GptTokenCounter` uses **gpt-tokenizer** (o200k BPE, pure JS, no WASM, no network).
   Chat overhead follows OpenAI's formula (+4 per message, +3 reply priming).
2. A configurable **multiplier** (`TOKEN_ESTIMATE_MULTIPLIER`, default 1.1) biases estimates upward.
3. **Text is tokenized in 512-char chunks.** BPE is quadratic in the length of one pre-token: a
   single 32,000-char run of one character took **3.8 s** of blocking CPU (measured), so one request
   could freeze the event loop for every stream on the instance. Chunking makes the cost linear
   (that same input: ~3 ms; 256 KB of random characters, the worst case measured: ~135 ms). It
   overcounts by ~0.5 % on normal text, in the safe direction. Surrogate pairs are never split.
4. Accuracy is not what guarantees the hard limit. Two mechanisms do:
   - the provider is called with `max_tokens = effective`, so output can't exceed what was reserved;
   - reconcile charges `min(actual, reserved)`, so even an underestimated input never pushes the
     charge above the reservation (FR5).

## Consequences

- The estimate decides _when_ a student sees `budget_exhausted` (slightly early on long
  conversations), not _whether_ the budget can be exceeded.
- Provider-reported usage is preferred whenever present (`usage_source: provider` in logs).
- Residual cost: a maximum-size adversarial body costs ~0.1 s of CPU. This is bounded by the
  256 KB body limit and by the per-attempt rate limit, which runs before tokenization in the
  pipeline. Moving tokenization to a worker pool is the next step if load tests show it matters.

## Alternatives

- `chars / 3` heuristic: O(n) and conservative for English, but wrong by 2–4× for code with long
  identifiers and for non-Latin scripts.
- UTF-8 byte count (a strict upper bound for byte-level BPE): safe, but overestimates ~3–4×,
  which would exhaust budgets far too early.
- Calling a provider's tokenize endpoint: adds a network round trip to the ≤ 50 ms budget.

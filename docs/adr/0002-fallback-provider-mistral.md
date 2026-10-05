# ADR-0002: Fallback provider is Mistral (La Plateforme, free "Experiment" plan)

- Status: accepted
- Date: 2026-10-03 (free-tier terms verified on this date)

## Context

The spec asks for a second **free**, **OpenAI-compatible** provider from a **different vendor**
than Groq, used only as a failover target (FR6). PLAN.md's tentative candidate was Cerebras.
Before committing, each candidate's current terms were checked:

| candidate     | free? (2026-10-03)                                                                                                             | OpenAI-compatible streaming                                     | notes                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Cerebras**  | **No longer.** Since 2026-07-16 the permanent free tier was replaced by a $5 / 30-day trial credit that needs a payment method | yes (`api.cerebras.ai/v1`)                                      | rejected: not free                                                                                                            |
| **Mistral**   | **Yes**: free "Experiment" plan (RPS, tokens/min and tokens/month limits shown in the console)                                 | yes (`api.mistral.ai/v1/chat/completions`, SSE, `data: [DONE]`) | free mode _may_ use API data for training, **opt-out available**                                                              |
| Google Gemini | yes (AI Studio free tier)                                                                                                      | partial (`/v1beta/openai/` compatibility layer)                 | free-tier data is used to improve Google products, with no opt-out                                                            |
| OpenRouter    | yes (`:free` models, ~20 RPM / 50 requests/day)                                                                                | yes                                                             | an aggregator, not a vendor: it may route to the same upstream as Groq, which defeats vendor diversity; the daily cap is tiny |
| SambaNova     | trial credits                                                                                                                  | yes                                                             | credit-based, not a stable free tier                                                                                          |

## Decision

- Fallback provider: **Mistral**, model `mistral-small-latest`. Default `FALLBACK_MODELS=mistral:mistral-small-latest`.
- `MistralProvider` reuses the OpenAI-compatible base adapter with one difference: it does **not**
  send `stream_options` (not in Mistral's documented request schema). Usage is read from the
  stream if present; otherwise the gateway counts the streamed tokens (same path as any provider
  that omits usage).
- **Operational requirement:** opt out of training on API data in the Mistral console before
  using real student traffic. Student prompts contain their interview work.
- The vendor is config, not code: switching (e.g. to a paid tier, or back to Cerebras) is a new
  `FALLBACK_MODELS` value plus, at most, a small adapter subclass and one registry line.

## Consequences

- Real vendor diversity: an outage or 429 storm at Groq does not affect Mistral.
- Free-plan rate limits are low. The fallback absorbs bursts of Groq failures, not sustained
  full traffic. Load tests use the fake provider, never Mistral.
- The free-tier status of every vendor changes often (Cerebras changed three months ago). This
  ADR records the date of verification; re-check before production.

## Sources (checked 2026-10-03)

- Cerebras free-tier change: https://toolfreebie.com/cerebras-free-api/ , https://itsfree.dev/tools/cerebras
- Mistral free API on the Experiment plan: https://docs.mistral.ai/admin/billing-usage/usage-limits ,
  https://mistral.ai/products/la-plateforme
- Mistral training on free-mode data + opt-out: https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models
- Mistral chat completions API (stream, `[DONE]`): https://docs.mistral.ai/api/
- Provider comparisons: https://openrouter.ai/blog/tutorials/free-llm-apis-compared/ ,
  https://merginit.com/blog/16062026-free-ai-api-inference-comparison
- Groq streaming usage (`stream_options.include_usage`, legacy `x_groq.usage`): https://apis.io/asyncapis/groq/groq-asyncapi/

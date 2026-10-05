import { ConfigError, type Config } from '../../config/loadConfig.js';
import type { LlmProvider, ResolvedModel } from '../../domain/ports.js';
import { formatModelRef, type ModelRef } from '../../domain/types.js';
import { GroqProvider } from './GroqProvider.js';
import { MistralProvider } from './MistralProvider.js';
import { OpenAiCompatibleProvider, type FetchFn } from './OpenAiCompatibleProvider.js';

/**
 * Factory per provider name. Adding a vendor = one adapter + one line here (OCP); services and
 * routes never change. A factory returns undefined when the provider is not configured.
 */
type ProviderFactory = (config: Config, fetchFn: FetchFn | undefined) => LlmProvider | undefined;

const FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  groq: ({ providers: { groq } }, fetchFn) =>
    groq &&
    new GroqProvider({
      apiKey: groq.apiKey,
      ...opt('baseUrl', groq.baseUrl),
      ...opt('fetch', fetchFn),
    }),
  mistral: ({ providers: { mistral } }, fetchFn) =>
    mistral &&
    new MistralProvider({
      apiKey: mistral.apiKey,
      ...opt('baseUrl', mistral.baseUrl),
      ...opt('fetch', fetchFn),
    }),
  fake: ({ providers: { fake } }, fetchFn) =>
    fake &&
    new OpenAiCompatibleProvider({
      name: 'fake',
      baseUrl: fake.baseUrl,
      apiKey: 'fake-key',
      ...opt('fetch', fetchFn),
    }),
};

/** Registry of configured providers + the ordered model chain (primary, then fallbacks). */
export class ProviderRegistry {
  constructor(
    private readonly providers: ReadonlyMap<string, LlmProvider>,
    private readonly chain: readonly ModelRef[],
  ) {}

  /** Build from config. Fails fast if a configured model's provider is unknown or has no key. */
  static fromConfig(config: Config, fetchFn?: FetchFn): ProviderRegistry {
    const providers = new Map<string, LlmProvider>();
    for (const [name, factory] of Object.entries(FACTORIES)) {
      const provider = factory(config, fetchFn);
      if (provider) providers.set(name, provider);
    }
    const chain = [config.models.primary, ...config.models.fallbacks];
    const issues = chain
      .filter((ref) => !providers.has(ref.provider))
      .map((ref) =>
        ref.provider in FACTORIES
          ? `${formatModelRef(ref)}: provider "${ref.provider}" is not configured (missing API key/URL)`
          : `${formatModelRef(ref)}: unknown provider "${ref.provider}"`,
      );
    if (issues.length > 0) throw new ConfigError(issues);
    return new ProviderRegistry(providers, chain);
  }

  /** The failover order for every request: primary first, then FALLBACK_MODELS in order. */
  modelChain(): ResolvedModel[] {
    return this.chain.map((ref) => {
      const provider = this.providers.get(ref.provider);
      // Unreachable after fromConfig's validation; kept as a guard for direct construction.
      if (!provider) throw new Error(`provider ${ref.provider} not registered`);
      return { ref, provider };
    });
  }
}

/** Include `{ key: value }` only when value is defined (exactOptionalPropertyTypes-friendly). */
function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

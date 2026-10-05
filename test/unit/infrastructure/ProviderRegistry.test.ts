import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/config/loadConfig.js';
import { GroqProvider } from '../../../src/infrastructure/providers/GroqProvider.js';
import { MistralProvider } from '../../../src/infrastructure/providers/MistralProvider.js';
import { OpenAiCompatibleProvider } from '../../../src/infrastructure/providers/OpenAiCompatibleProvider.js';
import { ProviderRegistry } from '../../../src/infrastructure/providers/ProviderRegistry.js';
import { testConfig } from '../../helpers/testConfig.js';

describe('ProviderRegistry', () => {
  it('builds the chain primary → fallbacks from config', () => {
    const registry = ProviderRegistry.fromConfig(
      testConfig({
        GROQ_API_KEY: 'g',
        MISTRAL_API_KEY: 'm',
        PRIMARY_MODEL: 'groq:llama-3.3-70b-versatile',
        FALLBACK_MODELS: 'mistral:mistral-small-latest, groq:llama-3.1-8b-instant',
      }),
    );
    const chain = registry.modelChain();
    expect(chain.map((m) => `${m.ref.provider}:${m.ref.model}`)).toEqual([
      'groq:llama-3.3-70b-versatile',
      'mistral:mistral-small-latest',
      'groq:llama-3.1-8b-instant',
    ]);
    expect(chain[0]?.provider).toBeInstanceOf(GroqProvider);
    expect(chain[1]?.provider).toBeInstanceOf(MistralProvider);
    expect(chain[2]?.provider).toBe(chain[0]?.provider); // one adapter instance per provider
  });

  it('supports the fake provider and an empty fallback list', () => {
    const registry = ProviderRegistry.fromConfig(
      testConfig({
        FAKE_PROVIDER_BASE_URL: 'http://localhost:8090/v1',
        PRIMARY_MODEL: 'fake:ok?words=3',
        FALLBACK_MODELS: '',
      }),
    );
    const chain = registry.modelChain();
    expect(chain).toHaveLength(1);
    expect(chain[0]?.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(chain[0]?.ref.model).toBe('ok?words=3');
  });

  it('fails fast when a referenced provider has no credentials', () => {
    expect(() =>
      ProviderRegistry.fromConfig(testConfig({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: '' })),
    ).toThrow(/mistral:mistral-small-latest: provider "mistral" is not configured/);
  });

  it('fails fast on an unknown provider', () => {
    expect(() =>
      ProviderRegistry.fromConfig(
        testConfig({ GROQ_API_KEY: 'g', FALLBACK_MODELS: 'openai:gpt-4o' }),
      ),
    ).toThrow(ConfigError);
  });
});

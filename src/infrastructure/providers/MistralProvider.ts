import type { ProviderRequest } from '../../domain/types.js';
import {
  OpenAiCompatibleProvider,
  type OpenAiCompatibleOptions,
} from './OpenAiCompatibleProvider.js';

export const MISTRAL_DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

/**
 * Mistral (fallback vendor, ADR-0002). OpenAI-compatible chat completions, but `stream_options`
 * is not in its documented request schema, so it is not sent. Mistral reports `usage` on the
 * final chunk itself; if it ever doesn't, the gateway counts streamed tokens instead.
 */
export class MistralProvider extends OpenAiCompatibleProvider {
  constructor(options: Omit<OpenAiCompatibleOptions, 'name' | 'baseUrl'> & { baseUrl?: string }) {
    super({ ...options, name: 'mistral', baseUrl: options.baseUrl ?? MISTRAL_DEFAULT_BASE_URL });
  }

  protected override buildBody(request: ProviderRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      stream: true,
    };
  }
}

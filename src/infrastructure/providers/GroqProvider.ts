import type { Usage } from '../../domain/types.js';
import {
  OpenAiCompatibleProvider,
  toUsage,
  type OpenAiCompatibleOptions,
} from './OpenAiCompatibleProvider.js';

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Groq (primary). Fully OpenAI-compatible, including `stream_options.include_usage`. Older Groq
 * streams reported usage only under `x_groq.usage` on the final chunk, so both places are read.
 */
export class GroqProvider extends OpenAiCompatibleProvider {
  constructor(options: Omit<OpenAiCompatibleOptions, 'name' | 'baseUrl'> & { baseUrl?: string }) {
    super({ ...options, name: 'groq', baseUrl: options.baseUrl ?? GROQ_DEFAULT_BASE_URL });
  }

  protected override extractUsage(chunk: Record<string, unknown>): Usage | undefined {
    const xGroq = chunk.x_groq as { usage?: Parameters<typeof toUsage>[0] } | undefined;
    return super.extractUsage(chunk) ?? toUsage(xGroq?.usage);
  }
}

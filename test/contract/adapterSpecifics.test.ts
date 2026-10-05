/**
 * Vendor-specific behaviour on top of the shared contract: what each adapter sends, and where
 * it finds usage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import type { LlmProvider } from '../../src/domain/ports.js';
import type { ChatChunk } from '../../src/domain/types.js';
import { GroqProvider } from '../../src/infrastructure/providers/GroqProvider.js';
import { MistralProvider } from '../../src/infrastructure/providers/MistralProvider.js';
import { OpenAiCompatibleProvider } from '../../src/infrastructure/providers/OpenAiCompatibleProvider.js';

let server: FakeProviderServer;
beforeAll(async () => {
  server = await startFakeProviderServer();
});
afterAll(async () => {
  await server.close();
});

async function run(provider: LlmProvider, model: string): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  const req = { model, messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 77 };
  for await (const c of provider.streamChat(req, new AbortController().signal)) out.push(c);
  return out;
}

describe('request bodies', () => {
  it('generic/Groq send model, messages, max_tokens, stream and request in-stream usage', async () => {
    await run(new GroqProvider({ baseUrl: server.url, apiKey: 'secret-groq' }), 'ok');
    const last = server.requests.at(-1);
    expect(last?.body).toEqual({
      model: 'ok',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 77,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(last?.authorization).toBe('Bearer secret-groq');
  });

  it('Mistral omits stream_options (not in its documented schema)', async () => {
    await run(new MistralProvider({ baseUrl: server.url, apiKey: 'k' }), 'ok');
    expect(server.requests.at(-1)?.body).not.toHaveProperty('stream_options');
    expect(server.requests.at(-1)?.body).toMatchObject({ stream: true, max_tokens: 77 });
  });
});

describe('usage extraction', () => {
  it('Groq also reads the legacy x_groq.usage location', async () => {
    const chunks = await run(
      new GroqProvider({ baseUrl: server.url, apiKey: 'k' }),
      'x-groq-usage',
    );
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage?.type === 'usage' && usage.usage.outputTokens).toBe(5);
  });

  it('the generic adapter does not invent usage from vendor-specific fields', async () => {
    const generic = new OpenAiCompatibleProvider({ name: 'g', baseUrl: server.url, apiKey: 'k' });
    const chunks = await run(generic, 'x-groq-usage');
    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
  });
});

describe('SSE framing robustness', () => {
  it('handles a stream delivered one byte per TCP write', async () => {
    const chunks = await run(
      new GroqProvider({ baseUrl: server.url, apiKey: 'k' }),
      'split?words=4',
    );
    expect(chunks.flatMap((c) => (c.type === 'delta' ? [c.content] : []))).toEqual([
      'w1',
      ' w2',
      ' w3',
      ' w4',
    ]);
  });
});

describe('secrets', () => {
  it('does not put the API key or upstream body into errors', async () => {
    const p = new GroqProvider({ baseUrl: server.url, apiKey: 'sk-very-secret' });
    const err = await run(p, 'status-400').then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('HTTP 400');
    expect(JSON.stringify(err)).not.toContain('sk-very-secret');
    expect(JSON.stringify(err)).not.toContain('scripted status');
  });
});

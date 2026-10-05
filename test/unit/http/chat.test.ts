import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../../src/infrastructure/providers/FakeProvider.js';
import { ssePayloads, sseText } from '../../helpers/sse.js';
import { buildTestApp, type TestApp } from '../../helpers/testApp.js';
import { testToken } from '../../helpers/tokens.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

async function post(app: TestApp['app'], body: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${token ?? (await testToken())}` },
    payload: body as Record<string, unknown>,
  });
}

const hello = { messages: [{ role: 'user', content: 'hello' }] };

describe('POST /v1/chat/completions (FR1)', () => {
  it('streams OpenAI-format SSE: role, deltas, finish, usage, [DONE]', async () => {
    const provider = new FakeProvider('fake', { deltas: ['Hi', ' there'] });
    t = await buildTestApp({ models: [{ ref: { provider: 'fake', model: 'm' }, provider }] });
    const res = await post(t.app, hello);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['x-request-id']).toBe('req-1');
    expect(sseText(res.body)).toBe('Hi there');

    const payloads = ssePayloads(res.body);
    expect(payloads.at(-1)).toBe('[DONE]');
    expect(payloads[0]).toMatchObject({
      id: 'chatcmpl-req-1',
      object: 'chat.completion.chunk',
      model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
    });
    expect(payloads).toContainEqual(
      expect.objectContaining({ choices: [expect.objectContaining({ finish_reason: 'stop' })] }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    );
  });

  it('ignores client model / max_tokens and uses config + token claims', async () => {
    const provider = new FakeProvider('fake');
    t = await buildTestApp({
      models: [{ ref: { provider: 'fake', model: 'configured' }, provider }],
    });
    await post(
      t.app,
      { ...hello, model: 'gpt-4o-expensive', max_tokens: 999_999, temperature: 2 },
      await testToken({ maxTokensCap: 64 }),
    );
    expect(provider.calls[0]).toMatchObject({ model: 'configured', maxTokens: 64 });
  });

  it('requires a valid token (FR2) before looking at the body', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { not: 'even valid' },
    });
    expect(res.statusCode).toBe(401);
  });

  describe('validation (FR3) → 400', () => {
    it.each([
      ['no messages', { messages: [] }],
      ['101 messages', { messages: Array.from({ length: 101 }, () => hello.messages[0]) }],
      ['a 32,001-char message', { messages: [{ role: 'user', content: 'x'.repeat(32_001) }] }],
      ['a tool role', { messages: [{ role: 'tool', content: 'x' }] }],
      ['content parts', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }],
      ['only system messages', { messages: [{ role: 'system', content: 'x' }] }],
      ['a non-object body', 'just a string'],
    ])('%s', async (_label, body) => {
      t = await buildTestApp();
      const res = await post(t.app, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    });

    it('accepts exactly 100 messages of exactly 32,000 chars... if under 256 KB', async () => {
      t = await buildTestApp();
      const ok = await post(t.app, {
        messages: [{ role: 'user', content: 'x'.repeat(32_000) }],
      });
      expect(ok.statusCode).toBe(200);
      const many = await post(t.app, {
        messages: Array.from({ length: 100 }, () => ({ role: 'user', content: 'y' })),
      });
      expect(many.statusCode).toBe(200);
    });

    it('rejects a body over 256 KB', async () => {
      t = await buildTestApp();
      const res = await post(t.app, {
        messages: Array.from({ length: 9 }, () => ({ role: 'user', content: 'z'.repeat(30_000) })),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('answers 502 JSON (not SSE) when the provider fails before the first byte', async () => {
    const provider = new FakeProvider('fake', { failBeforeFirstChunk: 'server_error' });
    t = await buildTestApp({ models: [{ ref: { provider: 'fake', model: 'm' }, provider }] });
    const res = await post(t.app, hello);
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });

  it('after the first byte, sends an SSE error event and closes without [DONE] (FR6)', async () => {
    const provider = new FakeProvider('fake', {
      deltas: ['a', 'b', 'c'],
      failAfterDeltas: { count: 1, kind: 'server_error' },
    });
    t = await buildTestApp({ models: [{ ref: { provider: 'fake', model: 'm' }, provider }] });
    const res = await post(t.app, hello);
    expect(res.statusCode).toBe(200);
    const payloads = ssePayloads(res.body);
    expect(payloads.at(-1)).toEqual({
      error: { code: 'upstream_error', message: 'The model provider failed mid-response.' },
    });
    expect(payloads).not.toContain('[DONE]');
    expect(res.body).toContain('event: error');
  });
});

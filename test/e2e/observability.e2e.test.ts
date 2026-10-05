/** NFR8 (structured logs + request IDs) and metrics, through the real gateway composition. */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, type RealGateway } from '../helpers/realGateway.js';
import { testToken } from '../helpers/tokens.js';

let g: RealGateway;
beforeAll(async () => {
  g = await startRealGateway({ PRIMARY_MODEL: 'fake:ok?words=200&gap=10' });
});
afterAll(async () => {
  await g.stop();
});

async function chat(token: string) {
  const res = await fetch(`${g.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return res;
}

describe('structured logs with request ids (NFR8)', () => {
  it('every log line of a request carries its id; the id is returned to the client', async () => {
    const res = await chat(await testToken({ attemptId: uniqueAttemptId() }));
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const lines = g.logs.records.filter((r) => r.request_id === id);
    const messages = lines.map((r) => r.msg);
    expect(messages).toContain('chat completion finished');
    expect(messages).toContain('request completed'); // access log fires for hijacked SSE replies
    for (const line of lines) {
      expect(line).toMatchObject({ service: 'llm-gateway', level: expect.any(String) as string });
      expect(typeof line.time).toBe('string');
    }
    expect(lines.find((r) => r.msg === 'chat completion finished')).toMatchObject({
      attempt_id: expect.any(String) as string,
      outcome: 'completed',
      provider: 'fake',
      ttft_ms: expect.any(Number) as number,
      charged_tokens: expect.any(Number) as number,
    });
  });

  it('a client that hangs up mid-stream gets an access-log line with status 499', async () => {
    const token = await testToken({ attemptId: uniqueAttemptId() });
    const id = await new Promise<string>((resolve) => {
      const req = http.request(
        `${g.url}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve(String(res.headers['x-request-id']));
          });
        },
      );
      req.on('error', () => undefined);
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    });
    await expect
      .poll(() =>
        g.logs.records.find((r) => r.request_id === id && r.msg === 'request aborted by client'),
      )
      .toMatchObject({ status: 499, route: '/v1/chat/completions' });
  });
});

describe('metrics', () => {
  it('exposes HTTP, chat, provider and stream metrics with bounded labels', async () => {
    await chat(await testToken({ attemptId: uniqueAttemptId() }));
    await fetch(`${g.url}/v1/chat/completions`, { method: 'POST' }); // 401
    const text = await g.gateway.metrics.registry.metrics();

    expect(text).toMatch(
      /gateway_http_requests_total\{method="POST",route="\/v1\/chat\/completions",status="200"\} \d+/,
    );
    expect(text).toMatch(
      /gateway_http_requests_total\{method="POST",route="\/v1\/chat\/completions",status="401"\} \d+/,
    );
    expect(text).toMatch(/gateway_chat_requests_total\{outcome="completed"\} \d+/);
    expect(text).toMatch(/gateway_provider_requests_total\{provider="fake",result="ok"\} \d+/);
    expect(text).toContain('gateway_ttft_seconds_bucket');
    expect(text).toContain('gateway_active_streams 0');
    // Cardinality/privacy: no attempt ids or request ids in any label.
    expect(text).not.toMatch(/att-[0-9a-f]{8}/);
  });
});

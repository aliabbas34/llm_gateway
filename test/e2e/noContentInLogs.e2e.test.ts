/**
 * NFR9: NEVER log prompt or completion text. Also: never log credentials.
 *
 * Runs the real gateway at the most verbose log level, drives every path that touches content
 * (success, validation failures, malformed JSON, mid-stream error, failover, client disconnect,
 * budget exhaustion), captures every log line, and searches them for unique sentinels.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueAttemptId } from '../helpers/infra.js';
import { startRealGateway, type RealGateway } from '../helpers/realGateway.js';
import { TEST_SERVICE_API_KEY } from '../helpers/testConfig.js';
import { testToken } from '../helpers/tokens.js';

const PROMPT = 'PROMPT_SENTINEL_7f3a9c';
const SYSTEM_OVERRIDE = 'SYSTEM_SENTINEL_2b8e11';
const COMPLETION = 'COMPLETION_SENTINEL_d41c0e';
const CONFIGURED_SYSTEM_PROMPT = 'CONFIGURED_PROMPT_SENTINEL_99aa01';

let g: RealGateway;
let failing: RealGateway;
const tokens: string[] = [];

beforeAll(async () => {
  const env = { LOG_LEVEL: 'trace', SYSTEM_PROMPT: CONFIGURED_SYSTEM_PROMPT };
  // The completion text is set on the fake server, not in the model name (which is logged).
  g = await startRealGateway(
    { ...env, PRIMARY_MODEL: 'fake:status-503', FALLBACK_MODELS: 'fake:ok' },
    { upstreamText: `${COMPLETION} and more ${COMPLETION}` },
  );
  failing = await startRealGateway(
    { ...env, PRIMARY_MODEL: 'fake:midstream-error' },
    { upstreamText: `${COMPLETION} a b c d` },
  );
});
afterAll(async () => {
  await g.stop();
  await failing.stop();
});

async function newToken(overrides: Parameters<typeof testToken>[0] = {}) {
  const t = await testToken({ attemptId: uniqueAttemptId(), ...overrides });
  tokens.push(t);
  return t;
}

async function post(target: RealGateway, body: string, token: string) {
  const res = await fetch(`${target.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const conversation = JSON.stringify({
  messages: [
    { role: 'system', content: SYSTEM_OVERRIDE },
    { role: 'user', content: `Please help: ${PROMPT}` },
    { role: 'assistant', content: `Earlier answer ${COMPLETION}` },
    { role: 'user', content: PROMPT },
  ],
});

describe('no prompt, completion or secret in logs (NFR9)', () => {
  it('drives every content-bearing path, then finds no sentinel in any log line', async () => {
    // 1. success after a failover; the client really receives the completion
    const ok = await post(g, conversation, await newToken());
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(COMPLETION);

    // 2. validation failures whose bodies carry the prompt
    expect(
      (
        await post(
          g,
          JSON.stringify({ messages: [{ role: 'tool', content: PROMPT }] }),
          await newToken(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          g,
          JSON.stringify({ messages: [{ role: 'user', content: PROMPT.repeat(2_000) }] }),
          await newToken(),
        )
      ).status,
    ).toBe(400);

    // 3. malformed JSON: V8's JSON.parse error message quotes the input
    expect((await post(g, `{"messages": [${PROMPT}`, await newToken())).status).toBe(400);

    // 4. mid-stream provider error after content was streamed
    const mid = await post(failing, conversation, await newToken());
    expect(mid.status).toBe(200);
    expect(mid.text).toContain('event: error');

    // 5. budget exhausted
    expect((await post(g, conversation, await newToken({ tokenBudget: 20 }))).status).toBe(403);

    // 6. client disconnect mid-stream
    await new Promise<void>((resolve) => {
      void newToken().then((token) => {
        const req = http.request(
          `${g.url}/v1/chat/completions`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', () => undefined);
        req.end(conversation);
      });
    });

    // 7. a bad service key on the close endpoint
    await fetch(`${g.url}/v1/attempts/att-x/close`, {
      method: 'POST',
      headers: { authorization: `Bearer wrong-${TEST_SERVICE_API_KEY}` },
    });

    await g.gateway.usage.flush();
    await failing.gateway.usage.flush();
    await new Promise((r) => setTimeout(r, 200)); // let async completion logs land

    const allLogs = `${g.logs.text}\n${failing.logs.text}`;
    expect(g.logs.lines.length).toBeGreaterThan(10); // we really did capture logs
    for (const sentinel of [PROMPT, SYSTEM_OVERRIDE, COMPLETION, CONFIGURED_SYSTEM_PROMPT]) {
      expect(allLogs, `log leaked ${sentinel}`).not.toContain(sentinel);
    }
    for (const token of tokens) {
      expect(allLogs).not.toContain(token.split('.')[2]); // JWT signatures
    }
    expect(allLogs).not.toContain(TEST_SERVICE_API_KEY);

    // ...while still logging enough to debug: outcomes and failovers are there, by id.
    expect(
      g.logs.records.some((r) => r.msg === 'chat completion finished' && r.failover_count === 1),
    ).toBe(true);
    expect(
      g.logs.records.some((r) => r.msg === 'request rejected' && r.code === 'invalid_request'),
    ).toBe(true);
  });
});

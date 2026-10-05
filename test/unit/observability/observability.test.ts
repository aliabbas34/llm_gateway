import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../src/domain/errors.js';
import { ProviderError } from '../../../src/domain/providerErrors.js';
import { FakeProvider } from '../../../src/infrastructure/providers/FakeProvider.js';
import { InstrumentedChatCompletion } from '../../../src/observability/InstrumentedChatCompletion.js';
import { InstrumentedProvider } from '../../../src/observability/InstrumentedProvider.js';
import { createLogger } from '../../../src/observability/logger.js';
import { createMetrics } from '../../../src/observability/metrics.js';
import { startMetricsServer } from '../../../src/observability/metricsServer.js';
import { safeError } from '../../../src/observability/safeError.js';
import type { ChatResult } from '../../../src/application/ChatCompletionService.js';
import { LogCapture } from '../../helpers/logCapture.js';
import { RecordingSink } from '../../helpers/recordingSink.js';

describe('logger redaction (defence in depth for NFR9)', () => {
  it('censors content- and secret-bearing fields even if someone logs them', () => {
    const logs = new LogCapture();
    const log = createLogger({ log: { level: 'info' } }, logs);
    log.info(
      {
        body: { messages: [{ content: 'SECRET_PROMPT' }] },
        messages: ['SECRET_PROMPT'],
        content: 'SECRET_PROMPT',
        prompt: 'SECRET_PROMPT',
        completion: 'SECRET_COMPLETION',
        req: { headers: { authorization: 'Bearer SECRET_TOKEN' } },
        nested: { content: 'SECRET_PROMPT', apiKey: 'SECRET_KEY' },
      },
      'careless',
    );
    expect(logs.text).not.toMatch(/SECRET_/);
    expect(logs.text).toContain('[REDACTED]');
    expect(logs.records[0]).toMatchObject({
      level: 'info',
      service: 'llm-gateway',
      msg: 'careless',
    });
  });
});

describe('safeError', () => {
  it('keeps our own messages but drops third-party messages that may quote input', () => {
    let parseError: unknown;
    try {
      JSON.parse('{"x": PROMPT_TEXT');
    } catch (e) {
      parseError = e;
    }
    const wrapped = new ValidationError('bad json', { cause: parseError });
    const safe = safeError(wrapped);
    expect(safe).toEqual({
      name: 'ValidationError',
      code: 'invalid_request',
      message: 'bad json',
      cause: { name: 'SyntaxError' },
    });
    expect(JSON.stringify(safe)).not.toContain('PROMPT_TEXT');
  });

  it('keeps provider error kind/status and walks a bounded cause chain', () => {
    const net = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const err = new ProviderError('connection', 'groq', 'transport failure: ECONNREFUSED', {
      cause: new TypeError('fetch failed', { cause: net }),
      status: 503,
    });
    expect(safeError(err)).toEqual({
      name: 'ProviderError',
      message: 'transport failure: ECONNREFUSED',
      kind: 'connection',
      status: 503,
      cause: { name: 'TypeError', cause: { name: 'Error', code: 'ECONNREFUSED' } },
    });
    expect(safeError('a string')).toEqual({ name: 'string' });
  });
});

describe('InstrumentedProvider (decorator)', () => {
  it('passes chunks through and records result + first-chunk latency per provider', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const p = new InstrumentedProvider(new FakeProvider('groq', { deltas: ['a', 'b'] }), metrics);
    const chunks = [];
    for await (const c of p.streamChat(
      { model: 'm', messages: [], maxTokens: 1 },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === 'delta')).toHaveLength(2);
    expect(p.name).toBe('groq');
    const text = await metrics.registry.metrics();
    expect(text).toContain('gateway_provider_requests_total{provider="groq",result="ok"} 1');
    expect(text).toContain('gateway_provider_first_chunk_seconds_count{provider="groq"} 1');
  });

  it('records the error kind and rethrows the same error', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const p = new InstrumentedProvider(
      new FakeProvider('mistral', { failBeforeFirstChunk: 'rate_limited' }),
      metrics,
    );
    const iterate = async () => {
      const seen = [];
      for await (const chunk of p.streamChat(
        { model: 'm', messages: [], maxTokens: 1 },
        new AbortController().signal,
      )) {
        seen.push(chunk);
      }
      return seen;
    };
    await expect(iterate()).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(await metrics.registry.metrics()).toContain(
      'gateway_provider_requests_total{provider="mistral",result="rate_limited"} 1',
    );
  });
});

describe('InstrumentedChatCompletion (decorator)', () => {
  const result: ChatResult = {
    outcome: 'completed',
    model: { provider: 'groq', model: 'm' },
    usage: { inputTokens: 10, outputTokens: 5 },
    usageSource: 'provider',
    ttftMs: 120,
    addedLatencyMs: 8,
    latencyMs: 400,
    failoverCount: 1,
    failoverReasons: ['rate_limited'],
    reservedTokens: 100,
    chargedTokens: 15,
    remainingTokens: 85,
    settlement: 'settled',
  };
  const input = {
    requestId: 'r',
    claims: { studentId: 's', attemptId: 'a', maxTokensCap: 1, tokenBudget: 1, expiresAtSec: 0 },
    messages: [],
  };

  it('counts outcome, tokens, TTFT and failovers, and keeps the active gauge balanced', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    let activeDuring = -1;
    const svc = new InstrumentedChatCompletion(
      {
        complete: async () => {
          activeDuring = (await metrics.activeStreams.get()).values[0]?.value ?? -1;
          return result;
        },
      },
      metrics,
    );
    await svc.complete(input, new RecordingSink(), new AbortController().signal);
    const text = await metrics.registry.metrics();
    expect(activeDuring).toBe(1);
    expect(text).toContain('gateway_active_streams 0');
    expect(text).toContain('gateway_chat_requests_total{outcome="completed"} 1');
    expect(text).toContain('gateway_tokens_charged_total 15');
    expect(text).toContain('gateway_added_latency_seconds_bucket{le="0.01"} 1');
    expect(text).toContain('gateway_failovers_total{reason="rate_limited"} 1');
    expect(text).toContain('gateway_ttft_seconds_count{provider="groq"} 1');
  });

  it('labels thrown GatewayErrors by code', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    const svc = new InstrumentedChatCompletion(
      { complete: () => Promise.reject(new ValidationError('x')) },
      metrics,
    );
    await expect(
      svc.complete(input, new RecordingSink(), new AbortController().signal),
    ).rejects.toThrow();
    const text = await metrics.registry.metrics();
    expect(text).toContain('gateway_chat_requests_total{outcome="invalid_request"} 1');
    expect(text).toContain('gateway_active_streams 0');
  });
});

describe('metrics server', () => {
  it('serves GET /metrics in Prometheus format on its own port, 404 otherwise', async () => {
    const metrics = createMetrics();
    const server = await startMetricsServer(metrics.registry, '127.0.0.1', 0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const body = await res.text();
      expect(body).toContain('gateway_process_cpu_seconds_total');
      expect(body).toContain('gateway_nodejs_eventloop_lag_seconds');
      expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

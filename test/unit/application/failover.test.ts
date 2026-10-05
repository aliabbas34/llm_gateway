/**
 * FR6: failover only before the first byte, only to the configured fallbacks, only on
 * 429 / 5xx / timeout / connection; after the first byte, an in-stream error. Plus timeouts.
 */
import { describe, expect, it } from 'vitest';
import {
  ChatCompletionService,
  type ChatInput,
} from '../../../src/application/ChatCompletionService.js';
import { UsageRecorder } from '../../../src/application/UsageRecorder.js';
import { UpstreamUnavailableError } from '../../../src/domain/errors.js';
import type { ProviderErrorKind } from '../../../src/domain/providerErrors.js';
import type { ResolvedModel, TokenCounter } from '../../../src/domain/ports.js';
import {
  FakeProvider,
  type FakeScript,
} from '../../../src/infrastructure/providers/FakeProvider.js';
import { SystemClock } from '../../../src/infrastructure/system/SystemClock.js';
import { InMemoryBudgetStore, InMemoryUsageLedger } from '../../helpers/fakes.js';
import { RecordingSink } from '../../helpers/recordingSink.js';

const charCounter: TokenCounter = {
  countMessages: (msgs) => msgs.reduce((n, m) => n + m.content.length, 0),
  countText: (t) => t.length,
};

interface Candidate {
  readonly name: string;
  readonly script: FakeScript;
}

function setup(
  candidates: Candidate[],
  timeouts = { ttftMs: 5_000, idleMs: 5_000, maxStreamDurationMs: 30_000 },
) {
  const providers = candidates.map((c) => new FakeProvider(c.name, c.script));
  const models: ResolvedModel[] = providers.map((p, i) => ({
    ref: { provider: p.name, model: `model-${i}` },
    provider: p,
  }));
  const budget = new InMemoryBudgetStore();
  const ledger = new InMemoryUsageLedger();
  const recorder = new UsageRecorder(ledger, () => undefined);
  const svc = new ChatCompletionService({
    models,
    counter: charCounter,
    clock: new SystemClock(),
    systemPrompt: 'S',
    budget,
    usage: recorder,
    timeouts,
  });
  return { svc, providers, budget, ledger, recorder };
}

const input: ChatInput = {
  requestId: 'req-1',
  claims: {
    studentId: 's',
    attemptId: 'a',
    maxTokensCap: 100,
    tokenBudget: 1_000,
    expiresAtSec: 0,
  },
  messages: [{ role: 'user', content: 'hi' }],
};
const never = new AbortController().signal;
const ok: FakeScript = { deltas: ['fine'] };
const fail = (kind: ProviderErrorKind): FakeScript => ({ failBeforeFirstChunk: kind });

describe('failover before the first byte (FR6)', () => {
  it.each<ProviderErrorKind>(['rate_limited', 'server_error', 'timeout', 'connection'])(
    'fails over on %s and serves from the fallback',
    async (kind) => {
      const { svc, providers, ledger, recorder } = setup([
        { name: 'primary', script: fail(kind) },
        { name: 'fallback', script: ok },
      ]);
      const sink = new RecordingSink();
      const result = await svc.complete(input, sink, never);

      expect(sink.text).toBe('fine');
      expect(sink.events.filter((e) => e.type === 'open')).toEqual([
        { type: 'open', model: 'model-1' },
      ]);
      expect(result).toMatchObject({
        outcome: 'completed',
        model: { provider: 'fallback', model: 'model-1' },
        failoverCount: 1,
        failoverReasons: [kind],
      });
      expect(providers.map((p) => p.calls.length)).toEqual([1, 1]);
      // Same reservation, same limit for every candidate.
      expect(providers[1]?.calls[0]?.maxTokens).toBe(providers[0]?.calls[0]?.maxTokens);
      await recorder.flush();
      expect(ledger.rows.get('req-1')).toMatchObject({ failoverCount: 1, provider: 'fallback' });
    },
  );

  it.each<ProviderErrorKind>(['client_error', 'protocol_error'])(
    'does NOT fail over on %s (not in the FR6 list) → 502',
    async (kind) => {
      const { svc, providers } = setup([
        { name: 'primary', script: fail(kind) },
        { name: 'fallback', script: ok },
      ]);
      await expect(svc.complete(input, new RecordingSink(), never)).rejects.toBeInstanceOf(
        UpstreamUnavailableError,
      );
      expect(providers[1]?.calls).toHaveLength(0);
    },
  );

  it('tries candidates in configured order and gives up after the last → 502, release, ledger', async () => {
    const { svc, providers, budget, ledger, recorder } = setup([
      { name: 'a', script: fail('server_error') },
      { name: 'b', script: fail('rate_limited') },
      { name: 'c', script: fail('connection') },
    ]);
    const sink = new RecordingSink();
    const err = await svc.complete(input, sink, never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect((err as Error).message).toContain('a:server_error, b:rate_limited, c:connection');
    expect(providers.map((p) => p.calls.length)).toEqual([1, 1, 1]);
    expect(sink.events).toEqual([]);
    expect(budget.calls.at(-1)).toBe('release:req-1');
    await recorder.flush();
    expect(ledger.rows.get('req-1')).toMatchObject({
      outcome: 'upstream_error',
      provider: 'c',
      failoverCount: 2,
      chargedTokens: 0,
    });
  });

  it('never fails over after the first byte: mid-stream failure → in-stream error', async () => {
    const { svc, providers } = setup([
      {
        name: 'primary',
        script: { deltas: ['a', 'b'], failAfterDeltas: { count: 1, kind: 'server_error' } },
      },
      { name: 'fallback', script: ok },
    ]);
    const sink = new RecordingSink();
    const result = await svc.complete(input, sink, never);
    expect(result.outcome).toBe('stream_error');
    expect(sink.types()).toEqual(['open', 'delta', 'error', 'end']);
    expect(providers[1]?.calls).toHaveLength(0);
  });

  it('does not fail over when the client has gone', async () => {
    const { svc, providers } = setup([
      { name: 'primary', script: { firstChunkDelayMs: 500 } },
      { name: 'fallback', script: ok },
    ]);
    const abort = new AbortController();
    const done = svc.complete(input, new RecordingSink(), abort.signal);
    setTimeout(() => {
      abort.abort();
    }, 20);
    expect((await done).outcome).toBe('client_disconnected');
    expect(providers[1]?.calls).toHaveLength(0);
  });
});

describe('timeouts', () => {
  it('TTFT timeout on the primary fails over to the fallback', async () => {
    const { svc, providers } = setup(
      [
        { name: 'slow', script: { firstChunkDelayMs: 10_000 } },
        { name: 'fast', script: ok },
      ],
      { ttftMs: 50, idleMs: 5_000, maxStreamDurationMs: 30_000 },
    );
    const started = Date.now();
    const result = await svc.complete(input, new RecordingSink(), never);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ failoverReasons: ['timeout'], model: { provider: 'fast' } });
    expect(providers[0]?.calls).toHaveLength(1);
  });

  it('idle timeout after the first byte → upstream_timeout error event, charge what streamed', async () => {
    const { svc, budget } = setup(
      [{ name: 'stall', script: { deltas: ['abc', 'never'], hangAfterDeltas: 1 } }],
      { ttftMs: 5_000, idleMs: 50, maxStreamDurationMs: 30_000 },
    );
    const sink = new RecordingSink();
    const result = await svc.complete(input, sink, never);
    expect(result.outcome).toBe('stream_error');
    expect(sink.events).toContainEqual({ type: 'error', code: 'upstream_timeout' });
    expect(budget.calls.at(-1)).toBe(`reconcile:req-1:${'S'.length + 'hi'.length + 3}`);
  });

  it('the max stream duration ends a long stream even if chunks keep coming (ADR-0011)', async () => {
    const { svc } = setup(
      [
        {
          name: 'endless',
          script: { deltas: Array.from({ length: 1_000 }, () => 'x'), chunkDelayMs: 10 },
        },
      ],
      { ttftMs: 5_000, idleMs: 5_000, maxStreamDurationMs: 150 },
    );
    const sink = new RecordingSink();
    const started = Date.now();
    const result = await svc.complete(input, sink, never);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.outcome).toBe('stream_error');
    expect(sink.events).toContainEqual({ type: 'error', code: 'upstream_timeout' });
  });

  it('a slow sink does not trip the idle timeout (provider silence ≠ client slowness)', async () => {
    const { svc } = setup([{ name: 'p', script: { deltas: ['a', 'b', 'c'] } }], {
      ttftMs: 5_000,
      idleMs: 40,
      maxStreamDurationMs: 30_000,
    });
    const sink = new RecordingSink();
    const original = sink.delta.bind(sink);
    sink.delta = async (content: string) => {
      await new Promise((r) => setTimeout(r, 100)); // each write takes longer than idleMs
      return original(content);
    };
    const result = await svc.complete(input, sink, never);
    expect(result.outcome).toBe('completed');
    expect(sink.text).toBe('abc');
  });
});

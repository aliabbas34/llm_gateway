import { describe, expect, it } from 'vitest';
import {
  ChatCompletionService,
  type ChatInput,
} from '../../../src/application/ChatCompletionService.js';
import {
  CircuitBreaker,
  CircuitBreakers,
  type CircuitState,
} from '../../../src/application/CircuitBreaker.js';
import { UsageRecorder } from '../../../src/application/UsageRecorder.js';
import { UpstreamUnavailableError } from '../../../src/domain/errors.js';
import type { Clock, TokenCounter } from '../../../src/domain/ports.js';
import {
  FakeProvider,
  type FakeScript,
} from '../../../src/infrastructure/providers/FakeProvider.js';
import { InMemoryBudgetStore, InMemoryUsageLedger } from '../../helpers/fakes.js';
import { RecordingSink } from '../../helpers/recordingSink.js';

class ManualClock implements Clock {
  now = 0;
  nowMs(): number {
    return this.now;
  }
  monotonicMs(): number {
    return this.now;
  }
}

const OPTIONS = { failureThreshold: 3, openMs: 1_000 };

function breaker() {
  const clock = new ManualClock();
  const states: CircuitState[] = [];
  return { clock, states, circuit: new CircuitBreaker(clock, OPTIONS, (s) => states.push(s)) };
}

function failTimes(circuit: CircuitBreaker, times: number) {
  for (let i = 0; i < times; i++) circuit.tryAcquire()?.fail();
}

describe('CircuitBreaker', () => {
  it('opens after consecutive failures and skips the model', () => {
    const { circuit, states } = breaker();
    failTimes(circuit, 2);
    expect(circuit.tryAcquire()).toBeDefined();
    failTimes(circuit, 1);
    expect(states).toEqual(['open']);
    expect(circuit.tryAcquire()).toBeUndefined();
    expect(circuit.retryAfterMs()).toBe(1_000);
  });

  it('a success resets the consecutive failure count', () => {
    const { circuit, states } = breaker();
    failTimes(circuit, 2);
    circuit.tryAcquire()?.succeed();
    failTimes(circuit, 2);
    expect(states).toEqual([]);
  });

  it('allows exactly one probe after the open period; success closes the circuit', () => {
    const { circuit, clock, states } = breaker();
    failTimes(circuit, 3);
    clock.now = 1_000;
    const probe = circuit.tryAcquire();
    expect(probe).toBeDefined();
    expect(circuit.tryAcquire()).toBeUndefined();
    probe?.succeed();
    expect(states).toEqual(['open', 'half_open', 'closed']);
    expect(circuit.tryAcquire()).toBeDefined();
  });

  it('a failed probe reopens the circuit for a full period', () => {
    const { circuit, clock, states } = breaker();
    failTimes(circuit, 3);
    clock.now = 1_000;
    circuit.tryAcquire()?.fail();
    expect(states).toEqual(['open', 'half_open', 'open']);
    clock.now = 1_999;
    expect(circuit.tryAcquire()).toBeUndefined();
    clock.now = 2_000;
    expect(circuit.tryAcquire()).toBeDefined();
  });

  it('an abandoned probe frees the slot without changing health', () => {
    const { circuit, clock, states } = breaker();
    failTimes(circuit, 3);
    clock.now = 1_000;
    circuit.tryAcquire()?.abandon();
    expect(states).toEqual(['open', 'half_open']);
    expect(circuit.tryAcquire()).toBeDefined();
  });

  it('calls started before the circuit opened cannot close it later', () => {
    const { circuit, clock } = breaker();
    const old = circuit.tryAcquire();
    failTimes(circuit, 3);
    clock.now = 1_000;
    const probe = circuit.tryAcquire();
    old?.succeed();
    expect(circuit.tryAcquire()).toBeUndefined(); // still half-open, probe still running
    probe?.abandon();
  });

  it('keeps one independent breaker per model', () => {
    const circuits = new CircuitBreakers(new ManualClock(), OPTIONS);
    const a = { provider: 'groq', model: 'a' };
    failTimes(circuits.for(a), 3);
    expect(circuits.for(a).tryAcquire()).toBeUndefined();
    expect(circuits.for({ provider: 'groq', model: 'b' }).tryAcquire()).toBeDefined();
  });
});

describe('ChatCompletionService with open circuits (ADR-0020)', () => {
  const counter: TokenCounter = { countMessages: () => 5, countText: (t) => t.length };
  const input: ChatInput = {
    requestId: 'req',
    claims: { studentId: 's', attemptId: 'a', maxTokensCap: 50, tokenBudget: 1e6, expiresAtSec: 0 },
    messages: [{ role: 'user', content: 'hi' }],
  };

  function setup(primary: FakeScript, fallback: FakeScript) {
    const clock = new ManualClock();
    const providers = [
      new FakeProvider('primary', primary),
      new FakeProvider('fallback', fallback),
    ];
    const ledger = new InMemoryUsageLedger();
    const recorder = new UsageRecorder(ledger, () => undefined);
    const svc = new ChatCompletionService({
      models: providers.map((p) => ({ ref: { provider: p.name, model: 'm' }, provider: p })),
      counter,
      clock,
      systemPrompt: 'S',
      budget: new InMemoryBudgetStore(),
      usage: recorder,
      circuits: new CircuitBreakers(clock, OPTIONS),
      timeouts: { ttftMs: 5_000, idleMs: 5_000, maxStreamDurationMs: 30_000 },
    });
    let n = 0;
    const send = () =>
      svc.complete(
        { ...input, requestId: `req-${++n}` },
        new RecordingSink(),
        new AbortController().signal,
      );
    return { clock, providers, send, ledger, recorder };
  }

  it('stops calling a failing primary and goes straight to the fallback', async () => {
    const { providers, send } = setup({ failBeforeFirstChunk: 'server_error' }, { deltas: ['ok'] });
    for (let i = 0; i < 3; i++) expect((await send()).failoverCount).toBe(1);

    const result = await send();
    expect(result).toMatchObject({
      outcome: 'completed',
      failoverCount: 0,
      skippedModels: 1,
      model: { provider: 'fallback' },
    });
    expect(providers[0]?.calls).toHaveLength(3);
  });

  it('probes the primary again after the open period', async () => {
    const { clock, providers, send } = setup(
      { failBeforeFirstChunk: 'server_error' },
      { deltas: ['ok'] },
    );
    for (let i = 0; i < 3; i++) await send();
    clock.now = 1_000;
    await send();
    expect(providers[0]?.calls).toHaveLength(4);
  });

  it('answers 502 with Retry-After at once when every circuit is open', async () => {
    const down: FakeScript = { failBeforeFirstChunk: 'connection' };
    const { providers, send, ledger, recorder } = setup(down, down);
    for (let i = 0; i < 3; i++) await send().catch(() => undefined);

    const err = await send().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamUnavailableError);
    expect((err as UpstreamUnavailableError).retryAfterSec).toBe(1);
    expect(providers.map((p) => p.calls.length)).toEqual([3, 3]);
    await recorder.flush();
    expect(ledger.rows.get('req-4')).toMatchObject({
      outcome: 'upstream_error',
      model: null,
      chargedTokens: 0,
    });
  });

  it('ignores failures that say nothing about provider health', async () => {
    const { providers, send } = setup({ failBeforeFirstChunk: 'client_error' }, { deltas: ['ok'] });
    for (let i = 0; i < 5; i++) await send().catch(() => undefined);
    expect(providers[0]?.calls).toHaveLength(5);
  });

  it('a provider that keeps dying mid-answer trips its circuit', async () => {
    const { providers, send } = setup(
      { deltas: ['a', 'b'], failAfterDeltas: { count: 1, kind: 'timeout' } },
      { deltas: ['ok'] },
    );
    for (let i = 0; i < 3; i++) expect((await send()).outcome).toBe('stream_error');

    expect(await send()).toMatchObject({ outcome: 'completed', skippedModels: 1 });
    expect(providers[0]?.calls).toHaveLength(3);
  });
});

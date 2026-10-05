import { describe, expect, it } from 'vitest';
import {
  ChatCompletionService,
  type ChatInput,
} from '../../../src/application/ChatCompletionService.js';
import { UsageRecorder } from '../../../src/application/UsageRecorder.js';
import {
  AttemptClosedError,
  BudgetExhaustedError,
  DependencyUnavailableError,
  ShuttingDownError,
  UpstreamUnavailableError,
} from '../../../src/domain/errors.js';
import { ShutdownAbort } from '../../../src/domain/abort.js';
import type { LlmProvider, TokenCounter } from '../../../src/domain/ports.js';
import {
  FakeProvider,
  type FakeScript,
} from '../../../src/infrastructure/providers/FakeProvider.js';
import { SystemClock } from '../../../src/infrastructure/system/SystemClock.js';
import { InMemoryBudgetStore, InMemoryUsageLedger } from '../../helpers/fakes.js';
import { RecordingSink } from '../../helpers/recordingSink.js';

/** Deterministic counter: 1 token per character. */
const charCounter: TokenCounter = {
  countMessages: (msgs) => msgs.reduce((n, m) => n + m.content.length, 0),
  countText: (t) => t.length,
};

const SYS = 'SYS';
const TIMEOUTS = { ttftMs: 5_000, idleMs: 5_000, maxStreamDurationMs: 30_000 };
const INPUT_TOKENS = SYS.length + 'hello'.length; // 8 with charCounter

function setup(script: FakeScript | LlmProvider = {}, budget = new InMemoryBudgetStore()) {
  const provider: LlmProvider = 'streamChat' in script ? script : new FakeProvider('fake', script);
  const ledger = new InMemoryUsageLedger();
  const recorder = new UsageRecorder(ledger, () => undefined);
  const svc = new ChatCompletionService({
    models: [{ ref: { provider: 'fake', model: 'm1' }, provider }],
    counter: charCounter,
    clock: new SystemClock(),
    systemPrompt: SYS,
    budget,
    usage: recorder,
    timeouts: TIMEOUTS,
  });
  return { svc, provider, budget, ledger, recorder };
}

function input(overrides: Partial<ChatInput['claims']> = {}, requestId = 'req-1'): ChatInput {
  return {
    requestId,
    claims: {
      studentId: 'stu',
      attemptId: 'att',
      maxTokensCap: 100,
      tokenBudget: 1_000,
      expiresAtSec: 0,
      ...overrides,
    },
    messages: [
      { role: 'system', content: 'evil override' },
      { role: 'user', content: 'hello' },
    ],
  };
}

const never = new AbortController().signal;

describe('ChatCompletionService: happy path (FR1, FR5, FR8)', () => {
  it('reserves, streams, reconciles the actual usage, then writes one ledger row', async () => {
    const { svc, provider, budget, ledger, recorder } = setup({
      deltas: ['a', 'b'],
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    const sink = new RecordingSink();
    const result = await svc.complete(input(), sink, never);

    expect(sink.types()).toEqual(['open', 'delta', 'delta', 'finish', 'usage', 'end']);
    // reserve: input 8 + effective min(cap 100, 1000 - 8) = 108; charge 7 + 2 = 9
    expect(budget.calls).toEqual(['reserve:req-1', 'reconcile:req-1:9']);
    expect(budget.budgets.get('att')).toBe(1_000 - 9);
    expect(result).toMatchObject({
      outcome: 'completed',
      reservedTokens: 108,
      chargedTokens: 9,
      remainingTokens: 991,
      settlement: 'settled',
      usageSource: 'provider',
    });
    // The provider is held to the reservation: max_tokens = effective, not the client's wish.
    expect(provider instanceof FakeProvider && provider.calls[0]?.maxTokens).toBe(100);

    await recorder.flush();
    expect([...ledger.rows.values()]).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        attemptId: 'att',
        studentId: 'stu',
        model: 'm1',
        provider: 'fake',
        inputTokens: 7,
        outputTokens: 2,
        reservedTokens: 108,
        chargedTokens: 9,
        outcome: 'completed',
        failoverCount: 0,
      }),
    ]);
  });

  it('caps effective max_tokens by the remaining budget, not just the token cap', async () => {
    const { svc, provider } = setup({ deltas: ['x'] });
    await svc.complete(input({ tokenBudget: 40, maxTokensCap: 1_000 }), new RecordingSink(), never);
    expect(provider instanceof FakeProvider && provider.calls[0]?.maxTokens).toBe(
      40 - INPUT_TOKENS,
    );
  });

  it('estimates usage locally when the provider reports none', async () => {
    const { svc, budget } = setup({ deltas: ['abc', 'de'], usage: null });
    const result = await svc.complete(input(), new RecordingSink(), never);
    expect(result.usageSource).toBe('estimated');
    expect(result.usage).toEqual({ inputTokens: INPUT_TOKENS, outputTokens: 5 });
    expect(budget.calls).toContain(`reconcile:req-1:${INPUT_TOKENS + 5}`);
  });

  it('never charges more than reserved, even if the provider reports more usage', async () => {
    const { svc } = setup({ deltas: ['x'], usage: { inputTokens: 50, outputTokens: 5_000 } });
    const result = await svc.complete(input(), new RecordingSink(), never);
    expect(result.chargedTokens).toBe(result.reservedTokens);
  });
});

describe('ChatCompletionService: rejections', () => {
  it('budget exhausted → 403, no provider call, ledger row with zero charge', async () => {
    const { svc, provider, ledger, recorder } = setup();
    const sink = new RecordingSink();
    await expect(
      svc.complete(input({ tokenBudget: INPUT_TOKENS + 16 }), sink, never),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(provider instanceof FakeProvider && provider.calls).toEqual([]);
    expect(sink.events).toEqual([]);
    await recorder.flush();
    expect(ledger.rows.get('req-1')).toMatchObject({
      outcome: 'budget_exhausted',
      reservedTokens: 0,
      chargedTokens: 0,
      model: null,
    });
  });

  it('closed attempt → 403 attempt_closed and a ledger row', async () => {
    const budget = new InMemoryBudgetStore();
    budget.closed.add('att');
    const { svc, ledger, recorder } = setup({}, budget);
    await expect(svc.complete(input(), new RecordingSink(), never)).rejects.toBeInstanceOf(
      AttemptClosedError,
    );
    await recorder.flush();
    expect(ledger.rows.get('req-1')?.outcome).toBe('attempt_closed');
  });

  it('Redis down at reserve → 503, nothing streamed, no ledger row', async () => {
    const budget = new InMemoryBudgetStore();
    budget.failReserveWith = new DependencyUnavailableError('redis reserve failed');
    const { svc, ledger, recorder } = setup({}, budget);
    await expect(svc.complete(input(), new RecordingSink(), never)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    await recorder.flush();
    expect(ledger.rows.size).toBe(0);
  });
});

describe('ChatCompletionService: failure paths keep the reservation balanced', () => {
  it('provider fails before the first byte → release (charge 0), 502, upstream_error row', async () => {
    const { svc, budget, ledger, recorder } = setup({ failBeforeFirstChunk: 'server_error' });
    const sink = new RecordingSink();
    await expect(svc.complete(input(), sink, never)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
    expect(sink.opened).toBe(false);
    expect(budget.calls).toEqual(['reserve:req-1', 'release:req-1']);
    expect(budget.budgets.get('att')).toBe(1_000);
    await recorder.flush();
    expect(ledger.rows.get('req-1')).toMatchObject({ outcome: 'upstream_error', chargedTokens: 0 });
  });

  it('mid-stream failure → error event, reconcile input + streamed output', async () => {
    const { svc, budget } = setup({
      deltas: ['ab', 'cd', 'ef'],
      failAfterDeltas: { count: 2, kind: 'server_error' },
    });
    const sink = new RecordingSink();
    const result = await svc.complete(input(), sink, never);
    expect(sink.types()).toEqual(['open', 'delta', 'delta', 'error', 'end']);
    expect(result.outcome).toBe('stream_error');
    expect(budget.calls.at(-1)).toBe(`reconcile:req-1:${INPUT_TOKENS + 4}`);
  });

  it('client disconnect → abort, charge input + streamed estimate (capped at reserved)', async () => {
    const { svc, budget } = setup({ deltas: ['abcd', 'efgh', 'ijkl'], hangAfterDeltas: 2 });
    const sink = new RecordingSink();
    const abort = new AbortController();
    const done = svc.complete(input(), sink, abort.signal);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    const result = await done;
    expect(result.outcome).toBe('client_disconnected');
    expect(result.usage.outputTokens).toBe(8);
    expect(budget.calls.at(-1)).toBe(`reconcile:req-1:${INPUT_TOKENS + 8}`);
    expect(sink.types()).toEqual(['open', 'delta', 'delta', 'end']);
  });

  it('settle failure (Redis down at the end) → stream still ends, no ledger row (sweeper owns it)', async () => {
    const budget = new InMemoryBudgetStore();
    const { svc, ledger, recorder } = setup({ deltas: ['a'] }, budget);
    const sink = new RecordingSink();
    const done = svc.complete(input(), sink, never);
    budget.failSettleWith = new DependencyUnavailableError('redis settle failed');
    const result = await done;
    expect(result.settlement).toBe('failed');
    expect(result.chargedTokens).toBeNull();
    expect(sink.types().at(-1)).toBe('end');
    await recorder.flush();
    expect(ledger.rows.size).toBe(0);
    expect(budget.reservations.has('req-1')).toBe(true); // left for the sweeper
  });

  it('already settled (the sweeper won the race) → no second ledger row', async () => {
    const budget = new InMemoryBudgetStore();
    const provider: LlmProvider = {
      name: 'fake',
      async *streamChat() {
        yield { type: 'delta', content: 'x' };
        // While we stream, the reservation expires and is swept by another instance.
        budget.expire('req-1');
        await budget.sweepExpired(10);
      },
    };
    const { svc, ledger, recorder } = setup(provider, budget);
    const result = await svc.complete(input(), new RecordingSink(), never);
    expect(result.settlement).toBe('already_settled');
    await recorder.flush();
    expect(ledger.rows.size).toBe(0);
  });

  it('an unexpected throw after reserving still releases the reservation (try/finally)', async () => {
    const budget = new InMemoryBudgetStore();
    const { svc } = setup({ deltas: ['a'] }, budget);
    const sink = new RecordingSink();
    sink.delta = () => Promise.reject(new Error('transport bug'));
    await expect(svc.complete(input(), sink, never)).rejects.toThrow('transport bug');
    expect(budget.calls).toEqual(['reserve:req-1', 'release:req-1']);
    expect(budget.reservations.size).toBe(0);
  });

  it('wraps a non-ProviderError from an adapter (a bug) as a pre-commit failure', async () => {
    const provider: LlmProvider = {
      name: 'bad',
      // eslint-disable-next-line require-yield -- deliberately throws before yielding anything
      async *streamChat() {
        await Promise.resolve();
        throw new TypeError('adapter bug');
      },
    };
    const { svc } = setup(provider);
    await expect(svc.complete(input(), new RecordingSink(), never)).rejects.toBeInstanceOf(
      UpstreamUnavailableError,
    );
  });

  it('an abort before any output ends quietly without committing', async () => {
    const { svc } = setup({ firstChunkDelayMs: 1_000 });
    const sink = new RecordingSink();
    const abort = new AbortController();
    const done = svc.complete(input(), sink, abort.signal);
    abort.abort();
    const result = await done;
    expect(result).toMatchObject({ outcome: 'client_disconnected', ttftMs: null });
    expect(sink.types()).toEqual(['end']);
  });

  it('commits on a finish-only stream (empty completion)', async () => {
    const { svc } = setup({ deltas: [] });
    const sink = new RecordingSink();
    await svc.complete(input(), sink, never);
    expect(sink.types()).toEqual(['open', 'finish', 'usage', 'end']);
  });

  it('refuses to run without models (a wiring bug), releasing the reservation', async () => {
    const budget = new InMemoryBudgetStore();
    const svc = new ChatCompletionService({
      models: [],
      counter: charCounter,
      clock: new SystemClock(),
      systemPrompt: 'S',
      budget,
      usage: new UsageRecorder(new InMemoryUsageLedger(), () => undefined),
      timeouts: TIMEOUTS,
    });
    await expect(svc.complete(input(), new RecordingSink(), never)).rejects.toThrow('no models');
    expect(budget.reservations.size).toBe(0);
  });
});

describe('ChatCompletionService: shutdown', () => {
  it('shutdown before the first byte → 503 ShuttingDown, reservation released, ledger row', async () => {
    const { svc, budget, ledger, recorder } = setup({ firstChunkDelayMs: 1_000 });
    const sink = new RecordingSink();
    const shutdown = new AbortController();
    const done = svc.complete(input(), sink, shutdown.signal);
    setTimeout(() => {
      shutdown.abort(new ShutdownAbort());
    }, 20);
    await expect(done).rejects.toBeInstanceOf(ShuttingDownError);
    expect(sink.opened).toBe(false);
    expect(budget.calls.at(-1)).toBe('release:req-1');
    await recorder.flush();
    expect(ledger.rows.get('req-1')).toMatchObject({
      outcome: 'shutdown_aborted',
      chargedTokens: 0,
    });
  });

  it('shutdown mid-stream → shutting_down error event, charge what was streamed', async () => {
    const { svc, budget, ledger, recorder } = setup({
      deltas: ['abcd', 'efgh'],
      hangAfterDeltas: 1,
    });
    const sink = new RecordingSink();
    const shutdown = new AbortController();
    const done = svc.complete(input(), sink, shutdown.signal);
    setTimeout(() => {
      shutdown.abort(new ShutdownAbort());
    }, 30);
    const result = await done;
    expect(result.outcome).toBe('shutdown_aborted');
    expect(sink.events).toContainEqual({ type: 'error', code: 'shutting_down' });
    expect(budget.calls.at(-1)).toBe(`reconcile:req-1:${INPUT_TOKENS + 4}`);
    await recorder.flush();
    expect(ledger.rows.get('req-1')?.outcome).toBe('shutdown_aborted');
  });
});

describe('ChatCompletionService: added latency (NFR3 measurement)', () => {
  it('= pipeline time + (TTFT − the provider own TTFT): a slow provider does not count', async () => {
    const { svc } = setup({ firstChunkDelayMs: 120, deltas: ['a'] });
    const result = await svc.complete({ ...input(), pipelineMs: 7 }, new RecordingSink(), never);
    expect(result.ttftMs).toBeGreaterThanOrEqual(120);
    expect(result.addedLatencyMs).toBeGreaterThanOrEqual(7);
    expect(result.addedLatencyMs).toBeLessThan(7 + 40); // the 120 ms provider delay is excluded
  });

  it('is null when nothing was streamed', async () => {
    const { svc } = setup({ firstChunkDelayMs: 1_000 });
    const abort = new AbortController();
    const done = svc.complete(input(), new RecordingSink(), abort.signal);
    abort.abort();
    expect((await done).addedLatencyMs).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatCompletion, ChatResult } from '../../../src/application/ChatCompletionService.js';
import { DrainableChatCompletion } from '../../../src/application/DrainableChatCompletion.js';
import { Lifecycle } from '../../../src/application/Lifecycle.js';
import { ShutdownAbort } from '../../../src/domain/abort.js';
import { ShuttingDownError } from '../../../src/domain/errors.js';
import { RecordingSink } from '../../helpers/recordingSink.js';

const input = {
  requestId: 'r',
  claims: { studentId: 's', attemptId: 'a', maxTokensCap: 1, tokenBudget: 1, expiresAtSec: 0 },
  messages: [],
};
const result = { outcome: 'completed' } as ChatResult;

/** An inner completion that runs until released or aborted, recording the abort reason. */
function controllable() {
  const reasons: unknown[] = [];
  const releases: (() => void)[] = [];
  const inner: ChatCompletion = {
    complete: (_i, _s, signal) =>
      new Promise((resolve) => {
        releases.push(() => {
          resolve(result);
        });
        signal.addEventListener('abort', () => {
          reasons.push(signal.reason);
          resolve({ ...result, outcome: 'shutdown_aborted' });
        });
      }),
  };
  return {
    inner,
    reasons,
    releaseAll: () => {
      releases.forEach((r) => {
        r();
      });
    },
  };
}

describe('DrainableChatCompletion (graceful shutdown)', () => {
  it('tracks in-flight work and drains when it finishes', async () => {
    const { inner, releaseAll } = controllable();
    const d = new DrainableChatCompletion(inner, new Lifecycle());
    const a = d.complete(input, new RecordingSink(), new AbortController().signal);
    const b = d.complete(input, new RecordingSink(), new AbortController().signal);
    expect(d.activeCount).toBe(2);
    setTimeout(releaseAll, 20);
    await expect(d.drain(1_000)).resolves.toBe(true);
    await Promise.all([a, b]);
    expect(d.activeCount).toBe(0);
  });

  it('times out the drain, then abortAll() stops stragglers with a ShutdownAbort reason', async () => {
    const { inner, reasons } = controllable();
    const d = new DrainableChatCompletion(inner, new Lifecycle());
    const running = d.complete(input, new RecordingSink(), new AbortController().signal);
    await expect(d.drain(30)).resolves.toBe(false);
    d.abortAll();
    await expect(running).resolves.toMatchObject({ outcome: 'shutdown_aborted' });
    expect(reasons[0]).toBeInstanceOf(ShutdownAbort);
    await expect(d.drain(100)).resolves.toBe(true);
  });

  it('refuses new work once draining (503 + Retry-After)', async () => {
    const lifecycle = new Lifecycle();
    const d = new DrainableChatCompletion(controllable().inner, lifecycle);
    lifecycle.startDraining();
    await expect(
      d.complete(input, new RecordingSink(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ShuttingDownError);
    expect(d.activeCount).toBe(0);
  });

  it('a client abort still reaches the inner completion (signals are combined)', async () => {
    const { inner, reasons } = controllable();
    const d = new DrainableChatCompletion(inner, new Lifecycle());
    const client = new AbortController();
    const running = d.complete(input, new RecordingSink(), client.signal);
    client.abort();
    await running;
    expect(reasons[0]).not.toBeInstanceOf(ShutdownAbort);
  });

  it('drain with nothing in flight resolves immediately', async () => {
    const d = new DrainableChatCompletion(controllable().inner, new Lifecycle());
    await expect(d.drain(10)).resolves.toBe(true);
  });
});

/**
 * The LlmProvider contract, written once and run against every adapter (LSP): the in-process
 * FakeProvider and each OpenAI-compatible adapter talking real HTTP to the fake provider server.
 * An adapter that passes is substitutable anywhere the gateway uses a provider.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderErrorKind } from '../../src/domain/providerErrors.js';
import type { LlmProvider } from '../../src/domain/ports.js';
import type { ChatChunk } from '../../src/domain/types.js';

/** Behaviours every adapter must be able to exhibit, named after fake-server scenarios. */
export type ContractScenario =
  | 'ok'
  | 'no-usage'
  | 'status-429'
  | 'status-503'
  | 'status-400'
  | 'midstream-error'
  | 'garbage'
  | 'no-done'
  | 'connection-refused'
  | 'hang-body';

export interface ContractSubject {
  readonly provider: LlmProvider;
  readonly model: string;
}

export interface ContractHarness {
  /** Build a provider + model id that exhibits the scenario. */
  subject(scenario: ContractScenario): ContractSubject;
  /** Optional: resolves when the upstream observed the request being cancelled. */
  upstreamCancelled?(): Promise<unknown>;
}

const request = (model: string) => ({
  model,
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 32,
});

async function collect(
  subject: ContractSubject,
  signal = new AbortController().signal,
): Promise<{ chunks: ChatChunk[]; error: ProviderError | undefined }> {
  const chunks: ChatChunk[] = [];
  try {
    for await (const c of subject.provider.streamChat(request(subject.model), signal))
      chunks.push(c);
    return { chunks, error: undefined };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err; // contract: only ProviderError escapes
    return { chunks, error: err };
  }
}

const text = (chunks: ChatChunk[]) =>
  chunks.map((c) => (c.type === 'delta' ? c.content : '')).join('');

export function describeProviderContract(name: string, harness: ContractHarness): void {
  describe(`LlmProvider contract: ${name}`, () => {
    it('streams deltas in order, then finish and usage', async () => {
      const { chunks, error } = await collect(harness.subject('ok'));
      expect(error).toBeUndefined();
      expect(text(chunks)).toBe('w1 w2 w3 w4 w5');
      expect(chunks).toContainEqual({ type: 'finish', reason: 'stop' });
      const usage = chunks.find((c) => c.type === 'usage');
      expect(usage).toMatchObject({ type: 'usage', usage: { outputTokens: 5 } });
      // No empty deltas leak through (e.g. the role-only first chunk).
      expect(chunks.filter((c) => c.type === 'delta' && c.content === '')).toEqual([]);
    });

    it('omits the usage chunk when the provider reports none', async () => {
      const { chunks, error } = await collect(harness.subject('no-usage'));
      expect(error).toBeUndefined();
      expect(chunks.some((c) => c.type === 'usage')).toBe(false);
      expect(text(chunks)).toBe('w1 w2 w3 w4 w5');
    });

    it.each<[ContractScenario, ProviderErrorKind, boolean]>([
      ['status-429', 'rate_limited', true],
      ['status-503', 'server_error', true],
      ['status-400', 'client_error', false],
      ['connection-refused', 'connection', true],
    ])('classifies %s before any chunk as %s (retryable=%s)', async (scenario, kind, retryable) => {
      const { chunks, error } = await collect(harness.subject(scenario));
      expect(chunks).toEqual([]);
      expect(error?.kind).toBe(kind);
      expect(error?.retryable).toBe(retryable);
      expect(error?.provider).toBe(harness.subject(scenario).provider.name);
    });

    it('carries Retry-After on rate limits', async () => {
      const { error } = await collect(harness.subject('status-429'));
      expect(error?.retryAfterSec).toBe(2);
    });

    it.each<[ContractScenario, ProviderErrorKind]>([
      ['midstream-error', 'server_error'],
      ['garbage', 'protocol_error'],
      ['no-done', 'protocol_error'],
    ])('classifies %s after first chunk as %s', async (scenario, kind) => {
      const { chunks, error } = await collect(harness.subject(scenario));
      expect(chunks.some((c) => c.type === 'delta')).toBe(true);
      expect(error?.kind).toBe(kind);
    });

    it('stops promptly and throws aborted when the signal is aborted mid-stream', async () => {
      const abort = new AbortController();
      const subject = harness.subject('hang-body');
      const cancelled = harness.upstreamCancelled?.();
      const chunks: ChatChunk[] = [];
      const consume = (async () => {
        for await (const c of subject.provider.streamChat(request(subject.model), abort.signal)) {
          chunks.push(c);
          if (c.type === 'delta') abort.abort();
        }
      })();
      const err = await consume.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('aborted');
      expect((err as ProviderError).retryable).toBe(false);
      expect(text(chunks)).toBe('w1');
      if (cancelled) await expect(cancelled).resolves.toBeDefined();
    });

    it('surfaces a ProviderError reason passed to abort() (e.g. a timeout) unchanged', async () => {
      const abort = new AbortController();
      const subject = harness.subject('hang-body');
      const timeout = new ProviderError('timeout', subject.provider.name, 'idle timeout');
      const consume = (async () => {
        for await (const c of subject.provider.streamChat(request(subject.model), abort.signal)) {
          if (c.type === 'delta') abort.abort(timeout);
        }
      })();
      await expect(consume).rejects.toBe(timeout);
    });
  });
}

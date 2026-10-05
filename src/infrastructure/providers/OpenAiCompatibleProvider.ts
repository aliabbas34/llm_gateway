import { ProviderError, kindForStatus } from '../../domain/providerErrors.js';
import type { LlmProvider } from '../../domain/ports.js';
import type { ChatChunk, ProviderRequest, Usage } from '../../domain/types.js';
import { parseSseStream, type SseEvent } from '../../http/sse/SseParser.js';

/**
 * The slice of `fetch` the adapter uses, as a structural type: the global fetch, undici's fetch
 * bound to a dedicated connection pool (what production uses, see gateway.ts) and test doubles
 * all fit it without casts.
 */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}>;

export interface OpenAiCompatibleOptions {
  /** Registry name, used in errors, logs and the ledger (e.g. "groq"). */
  readonly name: string;
  /** Base URL up to and including the version segment, e.g. https://api.groq.com/openai/v1 */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: FetchFn;
}

/** The subset of an OpenAI `chat.completion.chunk` we read. Everything is optional: trust nothing. */
interface OpenAiChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAiUsage | null;
  error?: unknown;
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Base adapter for any OpenAI-compatible `/chat/completions` streaming endpoint (raw fetch, no SDK).
 *
 * Template method: the request/response flow, SSE parsing and error classification are fixed
 * here; vendors override only the small hooks `buildBody` and `extractUsage`. Adding a vendor
 * means a subclass (or none, if it is fully compatible) plus a registry entry (OCP).
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? fetch;
  }

  async *streamChat(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    const response = await this.send(request, signal);
    const body = response.body;
    if (body === null) throw this.error('protocol_error', 'response has no body');

    let sawDone = false;
    try {
      for await (const event of parseSseStream(this.readBody(body, signal))) {
        if (event.data === '[DONE]') {
          sawDone = true;
          break;
        }
        yield* this.normalize(event);
      }
      if (!sawDone) throw this.error('protocol_error', 'stream ended without [DONE]');
    } finally {
      // If iteration never started, the body was never read: release it. (Once read, readBody's
      // own finally cancels it.)
      if (!body.locked) await body.cancel().catch(() => undefined);
    }
  }

  // --- vendor hooks ------------------------------------------------------------------------

  /** Request body. The default asks for usage in-stream (OpenAI `stream_options`). */
  protected buildBody(request: ProviderRequest): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  /** Where this vendor reports usage in a stream chunk. Default: top-level `usage`. */
  protected extractUsage(chunk: Record<string, unknown>): Usage | undefined {
    return toUsage((chunk as OpenAiChunk).usage);
  }

  // --- fixed flow --------------------------------------------------------------------------

  private async send(
    request: ProviderRequest,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<FetchFn>>> {
    let response: Awaited<ReturnType<FetchFn>>;
    try {
      response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(this.buildBody(request)),
        signal,
      });
    } catch (err) {
      throw this.transportError(err, signal);
    }

    if (!response.ok) {
      // Never read the error body into our error: it may echo the prompt. Cancel it instead.
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(
        kindForStatus(response.status),
        this.name,
        `HTTP ${response.status}`,
        {
          status: response.status,
          ...retryAfter(response.headers.get('retry-after')),
        },
      );
    }
    return response;
  }

  /** Iterate the body, translating read failures into classified errors. */
  private async *readBody(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    try {
      for (;;) {
        const result = await reader.read().catch((err: unknown) => {
          throw this.transportError(err, signal);
        });
        if (result.done) return;
        yield result.value;
      }
    } finally {
      // Runs on normal end, on error, and when the consumer stops early (client disconnect, failover,
      // [DONE] seen): cancelling releases the upstream socket. A no-op on a finished stream.
      await reader.cancel().catch(() => undefined);
    }
  }

  private *normalize(event: SseEvent): Generator<ChatChunk> {
    let chunk: unknown;
    try {
      chunk = JSON.parse(event.data);
    } catch (err) {
      throw this.error('protocol_error', 'invalid JSON in stream event', err);
    }
    if (typeof chunk !== 'object' || chunk === null) {
      throw this.error('protocol_error', 'stream event is not an object');
    }
    const c = chunk as OpenAiChunk & Record<string, unknown>;
    if (event.event === 'error' || c.error !== undefined) {
      throw this.error('server_error', 'provider sent an error event mid-stream');
    }

    const choice = c.choices?.[0];
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content.length > 0) yield { type: 'delta', content };
    const reason = choice?.finish_reason;
    if (typeof reason === 'string' && reason.length > 0) yield { type: 'finish', reason };

    const usage = this.extractUsage(c);
    if (usage) yield { type: 'usage', usage };
  }

  private transportError(err: unknown, signal: AbortSignal): ProviderError {
    if (signal.aborted) {
      // Our own cancellation (client disconnect, timeout, shutdown). The reason, if it is a
      // ProviderError (e.g. a timeout raised by the failover layer), wins.
      const reason: unknown = signal.reason;
      if (reason instanceof ProviderError) return reason;
      return this.error('aborted', 'request aborted', err);
    }
    return this.error('connection', `transport failure: ${errorName(err)}`, err);
  }

  private error(kind: ProviderError['kind'], message: string, cause?: unknown): ProviderError {
    return new ProviderError(kind, this.name, message, cause === undefined ? {} : { cause });
  }
}

export function toUsage(raw: OpenAiUsage | null | undefined): Usage | undefined {
  if (raw === null || raw === undefined) return undefined;
  const input = raw.prompt_tokens;
  const output = raw.completion_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
    return undefined;
  return { inputTokens: Math.round(input), outputTokens: Math.round(output) };
}

function retryAfter(header: string | null): { retryAfterSec?: number } {
  if (header === null) return {};
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSec: seconds } : {};
}

/** Error class / code only; never the message, which for some errors includes URLs or data. */
function errorName(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause as { code?: unknown } | undefined;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;
    return code ?? err.name;
  }
  return typeof err;
}

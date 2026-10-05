import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { ChatSink } from '../../application/ChatSink.js';
import type { Usage } from '../../domain/types.js';

/**
 * Writes OpenAI-format SSE (`chat.completion.chunk` events, then `data: [DONE]`).
 *
 * - Headers are deferred until `open()` (the commit point, FR6), so before that the route can
 *   still answer with a normal JSON error and status code.
 * - On open, Fastify is told the response is hijacked. Headers already set by hooks
 *   (x-request-id, CORS) are carried over.
 * - Writes honour backpressure: if the socket buffer is full, wait for 'drain' (or 'close').
 *   A slow client therefore slows the upstream read instead of growing memory, and a client that
 *   stops reading entirely is disconnected after `writeTimeoutMs` (which aborts the upstream).
 */
export class SseWriter implements ChatSink {
  private _opened = false;
  private errored = false;
  private firstDelta = true;
  private model = '';
  private created = 0;
  private readonly id: string;
  private readonly raw: ServerResponse;

  constructor(
    private readonly reply: FastifyReply,
    private readonly writeTimeoutMs: number,
  ) {
    this.raw = reply.raw;
    this.id = `chatcmpl-${reply.request.id}`;
  }

  get opened(): boolean {
    return this._opened;
  }

  open(meta: { readonly model: string }): void {
    if (this._opened) return;
    this._opened = true;
    this.model = meta.model;
    this.created = Math.floor(Date.now() / 1000);
    this.reply.hijack();
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(this.reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    this.raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // disable proxy buffering (nginx) so tokens flow immediately
    });
  }

  delta(content: string): Promise<void> {
    const delta = this.firstDelta ? { role: 'assistant', content } : { content };
    this.firstDelta = false;
    return this.data(this.chunk(delta, null));
  }

  finish(reason: string): Promise<void> {
    return this.data(this.chunk({}, reason));
  }

  usage(usage: Usage): Promise<void> {
    return this.data({
      ...this.chunk({}, null),
      choices: [],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    });
  }

  error(code: string, message: string): Promise<void> {
    this.errored = true;
    // `event: error` plus an `error` object in the data: the OpenAI SDKs raise on either.
    return this.write(`event: error\ndata: ${JSON.stringify({ error: { code, message } })}\n\n`);
  }

  async end(): Promise<void> {
    if (!this._opened) {
      // Nothing was ever sent (e.g. the client left before the first token). Close quietly.
      if (!this.reply.sent) this.reply.hijack();
      if (!this.raw.writableEnded) this.raw.end();
      return;
    }
    if (!this.errored) await this.write('data: [DONE]\n\n');
    if (!this.raw.writableEnded) this.raw.end();
  }

  private chunk(delta: Record<string, unknown>, finishReason: string | null) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  private data(payload: unknown): Promise<void> {
    return this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private write(text: string): Promise<void> {
    const raw = this.raw;
    if (raw.destroyed || raw.writableEnded) return Promise.resolve();
    if (raw.write(text)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        raw.off('drain', done);
        raw.off('close', done);
        resolve();
      };
      // Slow-consumer guard: destroying the socket fires 'close', which resolves this promise and
      // (via the route's close handler) aborts the upstream request.
      const timer = setTimeout(() => raw.destroy(), this.writeTimeoutMs);
      raw.on('drain', done);
      raw.on('close', done);
    });
  }
}

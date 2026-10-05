import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SseWriter } from '../../../src/http/sse/SseWriter.js';

/** Minimal stand-in for reply.raw: records writes, simulates backpressure on demand. */
class FakeRaw extends EventEmitter {
  readonly written: string[] = [];
  head: undefined | { status: number; headers: Record<string, unknown> };
  destroyed = false;
  writableEnded = false;

  constructor(private readonly backpressure: boolean) {
    super();
  }
  writeHead(status: number, headers: Record<string, unknown>): void {
    this.head = { status, headers };
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.backpressure;
  }
  end(): void {
    this.writableEnded = true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function fakeReply(opts: { backpressure?: boolean } = {}) {
  const raw = new FakeRaw(opts.backpressure ?? false);
  const reply = {
    raw,
    request: { id: 'req-9' },
    sent: false,
    hijack: vi.fn(),
    getHeaders: () => ({ 'x-request-id': 'req-9', 'x-undefined': undefined }),
  };
  return { reply: reply as unknown as FastifyReply, raw, hijack: reply.hijack };
}

describe('SseWriter', () => {
  it('defers headers until open(), then carries hook headers over', async () => {
    const { reply, raw, hijack } = fakeReply();
    const w = new SseWriter(reply, 1_000);
    expect(raw.head).toBeUndefined();
    w.open({ model: 'm' });
    expect(hijack).toHaveBeenCalledOnce();
    expect(raw.head?.status).toBe(200);
    expect(raw.head?.headers).toMatchObject({
      'x-request-id': 'req-9',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    expect(raw.head?.headers).not.toHaveProperty('x-undefined');
    await w.delta('hi');
    await w.end();
    expect(raw.written.at(-1)).toBe('data: [DONE]\n\n');
    expect(raw.writableEnded).toBe(true);
  });

  it('ending without ever opening hijacks and closes quietly (client already gone)', async () => {
    const { reply, raw, hijack } = fakeReply();
    await new SseWriter(reply, 1_000).end();
    expect(hijack).toHaveBeenCalledOnce();
    expect(raw.head).toBeUndefined();
    expect(raw.writableEnded).toBe(true);
  });

  it('an error event is final: no [DONE] afterwards', async () => {
    const { reply, raw } = fakeReply();
    const w = new SseWriter(reply, 1_000);
    w.open({ model: 'm' });
    await w.error('upstream_error', 'msg');
    await w.end();
    expect(raw.written.join('')).toContain('event: error');
    expect(raw.written.join('')).not.toContain('[DONE]');
  });

  it('waits for drain under backpressure, and disconnects a client that never drains', async () => {
    vi.useFakeTimers();
    try {
      const { reply, raw } = fakeReply({ backpressure: true });
      const w = new SseWriter(reply, 500);
      w.open({ model: 'm' });

      let resolved = false;
      const first = w.delta('a').then(() => (resolved = true));
      await vi.advanceTimersByTimeAsync(100);
      expect(resolved).toBe(false); // waiting for 'drain'
      raw.emit('drain');
      await first;

      const stuck = w.delta('b');
      await vi.advanceTimersByTimeAsync(500);
      await stuck;
      expect(raw.destroyed).toBe(true); // slow consumer cut off
      await w.delta('c'); // writes after destroy are no-ops
      expect(raw.written.filter((s) => s.includes('"c"'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

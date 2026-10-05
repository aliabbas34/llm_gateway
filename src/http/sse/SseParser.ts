/**
 * Incremental Server-Sent Events parser (WHATWG "event stream interpretation").
 *
 * Upstream bytes arrive in arbitrary TCP chunks: an event, a line, even a multi-byte UTF-8
 * character can be split across chunk boundaries. The parser keeps the unfinished tail between
 * `push()` calls and only emits complete events (dispatched on a blank line).
 *
 * Pure and dependency-free: it's used by the provider adapters (parsing upstream streams) and by
 * tests (parsing the gateway's own output).
 */

export interface SseEvent {
  /** `event:` field; undefined means the default "message" type. */
  readonly event: string | undefined;
  /** All `data:` lines joined with "\n". */
  readonly data: string;
  readonly id: string | undefined;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType: string | undefined;
  private lastId: string | undefined;
  private sawBom = false;

  /** Feed decoded text; returns the events completed by this chunk (possibly none). */
  push(text: string): SseEvent[] {
    let input = text;
    if (!this.sawBom) {
      if (input.length === 0) return [];
      this.sawBom = true;
      if (input.startsWith('﻿')) input = input.slice(1);
    }
    this.buffer += input;

    const events: SseEvent[] = [];
    let start = 0;
    for (;;) {
      const lineEnd = this.findLineEnd(start);
      if (lineEnd === undefined) break;
      const line = this.buffer.slice(start, lineEnd.index);
      start = lineEnd.index + lineEnd.length;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /**
   * End of input. Per spec, an event not terminated by a blank line is discarded: a stream cut off
   * mid-event must not produce a half event.
   */
  end(): void {
    this.buffer = '';
    this.dataLines = [];
    this.eventType = undefined;
  }

  /**
   * Find the next line terminator (\r\n, \n or \r). A trailing lone \r might be the first half of
   * a \r\n split across chunks, so it is only accepted once more input arrives.
   */
  private findLineEnd(from: number): { index: number; length: number } | undefined {
    for (let i = from; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch === 10) return { index: i, length: 1 }; // \n
      if (ch === 13) {
        // \r
        if (i + 1 >= this.buffer.length) return undefined; // wait: could be \r\n
        return { index: i, length: this.buffer.charCodeAt(i + 1) === 10 ? 2 : 1 };
      }
    }
    return undefined;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined; // comment / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        // `retry` and unknown fields are ignored: the gateway never reconnects upstream streams.
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventType = undefined;
      return undefined;
    }
    const event: SseEvent = {
      event: this.eventType,
      data: this.dataLines.join('\n'),
      id: this.lastId,
    };
    this.dataLines = [];
    this.eventType = undefined;
    return event;
  }
}

/**
 * Parse a byte stream into SSE events. UTF-8 decoding is streaming (`stream: true`), so a
 * multi-byte character split across chunks is reassembled correctly.
 */
export async function* parseSseStream(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser();
  for await (const chunk of body) {
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  parser.end();
}

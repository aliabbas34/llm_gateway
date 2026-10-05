import { describe, expect, it } from 'vitest';
import { SseParser, parseSseStream, type SseEvent } from '../../../src/http/sse/SseParser.js';

const BOM = String.fromCharCode(0xfeff);

const STREAM = [
  ': keep-alive comment\n',
  'data: {"a":1}\n\n',
  'event: error\ndata: {"error":"x"}\n\n',
  'data: line one\ndata: line two\n\n',
  'id: 7\ndata: with id\n\n',
  'data:no-space\n\n',
  'data: [DONE]\n\n',
].join('');

const EXPECTED: SseEvent[] = [
  { event: undefined, data: '{"a":1}', id: undefined },
  { event: 'error', data: '{"error":"x"}', id: undefined },
  { event: undefined, data: 'line one\nline two', id: undefined },
  { event: undefined, data: 'with id', id: '7' },
  { event: undefined, data: 'no-space', id: '7' },
  { event: undefined, data: '[DONE]', id: '7' },
];

function parseInPieces(text: string, cuts: number[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  let prev = 0;
  for (const cut of [...cuts, text.length]) {
    events.push(...parser.push(text.slice(prev, cut)));
    prev = cut;
  }
  return events;
}

describe('SseParser', () => {
  it('parses a whole stream in one push', () => {
    expect(new SseParser().push(STREAM)).toEqual(EXPECTED);
  });

  it('produces identical events for every single split point', () => {
    for (let cut = 0; cut <= STREAM.length; cut++) {
      expect(parseInPieces(STREAM, [cut])).toEqual(EXPECTED);
    }
  });

  it('produces identical events when fed one character at a time', () => {
    const cuts = Array.from({ length: STREAM.length }, (_, i) => i);
    expect(parseInPieces(STREAM, cuts)).toEqual(EXPECTED);
  });

  it('produces identical events for 200 random partitions (seeded)', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 200; run++) {
      const cuts = Array.from({ length: 1 + Math.floor(rand() * 12) }, () =>
        Math.floor(rand() * STREAM.length),
      ).sort((a, b) => a - b);
      expect(parseInPieces(STREAM, cuts)).toEqual(EXPECTED);
    }
  });

  it('accepts CRLF and lone CR line endings, including CRLF split across chunks', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    const cr = STREAM.replace(/\n/g, '\r');
    expect(new SseParser().push(crlf)).toEqual(EXPECTED);
    expect(parseInPieces(cr, [])).toEqual(EXPECTED.slice(0, -1)); // final CR still pending
    for (let cut = 0; cut <= crlf.length; cut++) {
      expect(parseInPieces(crlf, [cut])).toEqual(EXPECTED);
    }
  });

  it('strips a leading BOM, even when it arrives alone', () => {
    expect(parseInPieces(BOM + STREAM, [1])).toEqual(EXPECTED);
  });

  it('drops an event that is not terminated by a blank line', () => {
    const parser = new SseParser();
    expect(parser.push('data: complete\n\ndata: truncat')).toHaveLength(1);
    parser.end();
    expect(parser.push('\n\n')).toEqual([]);
  });

  it('ignores blank events and unknown fields', () => {
    expect(new SseParser().push('\n\nretry: 100\nfoo: bar\n\n')).toEqual([]);
  });
});

describe('parseSseStream', () => {
  async function* bytes(chunks: Uint8Array[]) {
    for (const c of chunks) {
      await Promise.resolve();
      yield c;
    }
  }

  it('reassembles multi-byte UTF-8 characters split across byte chunks', async () => {
    const encoded = new TextEncoder().encode('data: héllo 🚀 wörld\n\n');
    for (let cut = 1; cut < encoded.length; cut++) {
      const events: SseEvent[] = [];
      for await (const e of parseSseStream(bytes([encoded.slice(0, cut), encoded.slice(cut)]))) {
        events.push(e);
      }
      expect(events.map((e) => e.data)).toEqual(['héllo 🚀 wörld']);
    }
  });
});

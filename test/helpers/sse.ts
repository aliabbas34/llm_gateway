import { SseParser, type SseEvent } from '../../src/http/sse/SseParser.js';

/** Parse a complete SSE body (e.g. from app.inject) into events. */
export function parseSseBody(body: string): SseEvent[] {
  const parser = new SseParser();
  return parser.push(body);
}

/** The JSON payloads of a gateway SSE body, with [DONE] kept as a string marker. */
export function ssePayloads(body: string): (Record<string, unknown> | '[DONE]')[] {
  return parseSseBody(body).map((e) =>
    e.data === '[DONE]' ? '[DONE]' : (JSON.parse(e.data) as Record<string, unknown>),
  );
}

/** Concatenate the delta contents of a gateway SSE body. */
export function sseText(body: string): string {
  return ssePayloads(body)
    .map((p) => {
      if (p === '[DONE]') return '';
      const choices = p.choices as { delta?: { content?: string } }[] | undefined;
      return choices?.[0]?.delta?.content ?? '';
    })
    .join('');
}

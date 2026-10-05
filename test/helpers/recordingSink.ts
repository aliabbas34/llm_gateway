import type { ChatSink } from '../../src/application/ChatSink.js';
import type { Usage } from '../../src/domain/types.js';

export type SinkEvent =
  | { type: 'open'; model: string }
  | { type: 'delta'; content: string }
  | { type: 'finish'; reason: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; code: string }
  | { type: 'end' };

/** In-memory ChatSink that records every call, for service-level tests. */
export class RecordingSink implements ChatSink {
  readonly events: SinkEvent[] = [];
  opened = false;

  open(meta: { model: string }): void {
    this.opened = true;
    this.events.push({ type: 'open', model: meta.model });
  }
  delta(content: string): Promise<void> {
    this.events.push({ type: 'delta', content });
    return Promise.resolve();
  }
  finish(reason: string): Promise<void> {
    this.events.push({ type: 'finish', reason });
    return Promise.resolve();
  }
  usage(usage: Usage): Promise<void> {
    this.events.push({ type: 'usage', usage });
    return Promise.resolve();
  }
  error(code: string): Promise<void> {
    this.events.push({ type: 'error', code });
    return Promise.resolve();
  }
  end(): Promise<void> {
    this.events.push({ type: 'end' });
    return Promise.resolve();
  }

  get text(): string {
    return this.events.map((e) => (e.type === 'delta' ? e.content : '')).join('');
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

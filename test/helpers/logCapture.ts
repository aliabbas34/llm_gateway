import { Writable } from 'node:stream';

/** A pino destination that keeps every log line in memory for assertions. */
export class LogCapture extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  }

  get records(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

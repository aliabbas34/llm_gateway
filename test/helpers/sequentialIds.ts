import type { IdGenerator } from '../../src/domain/ports.js';

export class SequentialIds implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'req') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}

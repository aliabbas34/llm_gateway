import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../domain/ports.js';

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

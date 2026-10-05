import { performance } from 'node:perf_hooks';
import type { Clock } from '../../domain/ports.js';

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  monotonicMs(): number {
    return performance.now();
  }
}

import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../../src/infrastructure/system/SystemClock.js';
import { UuidGenerator } from '../../../src/infrastructure/system/UuidGenerator.js';

describe('SystemClock', () => {
  it('returns wall-clock epoch ms and a non-decreasing monotonic value', () => {
    const clock = new SystemClock();
    expect(Math.abs(clock.nowMs() - Date.now())).toBeLessThan(1_000);
    const a = clock.monotonicMs();
    const b = clock.monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe('UuidGenerator', () => {
  it('produces distinct v4 UUIDs', () => {
    const ids = new UuidGenerator();
    const a = ids.next();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids.next()).not.toBe(a);
  });
});

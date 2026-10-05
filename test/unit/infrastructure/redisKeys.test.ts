import { describe, expect, it } from 'vitest';
import { redisKeys } from '../../../src/infrastructure/redis/keys.js';

describe('redisKeys', () => {
  it('puts every per-attempt key in the same hash slot via a shared hash tag', () => {
    const keys = [
      redisKeys.budget('att-1'),
      redisKeys.status('att-1'),
      redisKeys.reservations('att-1'),
      redisKeys.attemptRate('att-1'),
    ];
    for (const k of keys) expect(k).toMatch(/^gw:\{att:att-1\}:/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps global keys out of attempt slots', () => {
    expect(redisKeys.reservationExpiry).toBe('gw:resv:expiry');
    expect(redisKeys.ipRate('10.0.0.1')).toBe('gw:rl:ip:10.0.0.1');
  });

  it.each(['', 'has space', 'a}b', 'x'.repeat(65), 'att:{1}'])(
    'refuses to build a key from the unsafe id %j',
    (id) => {
      expect(() => redisKeys.budget(id)).toThrow('invalid attempt id');
    },
  );
});

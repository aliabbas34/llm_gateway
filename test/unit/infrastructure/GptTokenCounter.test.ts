import { describe, expect, it } from 'vitest';
import { GptTokenCounter } from '../../../src/infrastructure/tokenizer/GptTokenCounter.js';

describe('GptTokenCounter (ADR-0008)', () => {
  it('counts text with the BPE and applies the safety multiplier upward', () => {
    const exact = new GptTokenCounter(1);
    const padded = new GptTokenCounter(1.5);
    const text = 'The quick brown fox jumps over the lazy dog.';
    const n = exact.countText(text);
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(text.length);
    expect(padded.countText(text)).toBe(Math.ceil(n * 1.5));
    expect(exact.countText('')).toBe(0);
  });

  it('adds per-message and reply-priming overhead', () => {
    const c = new GptTokenCounter(1);
    const one = c.countMessages([{ role: 'user', content: 'hello' }]);
    expect(one).toBe(c.countText('hello') + 4 + 3);
    const two = c.countMessages([
      { role: 'system', content: 'hello' },
      { role: 'user', content: 'hello' },
    ]);
    expect(two).toBe(one + c.countText('hello') + 4);
  });
});

describe('GptTokenCounter performance guard (adversarial input)', () => {
  it('counts a 32,000-char single-character run in well under 100 ms (no quadratic BPE)', () => {
    const c = new GptTokenCounter(1);
    c.countText('warm-up');
    const started = performance.now();
    const n = c.countText('x'.repeat(32_000));
    expect(performance.now() - started).toBeLessThan(100);
    expect(n).toBeGreaterThan(0);
  });

  it('does not split surrogate pairs at chunk boundaries', () => {
    const c = new GptTokenCounter(1);
    // 511 ASCII chars then an emoji: the pair straddles the 512-char boundary.
    const text = `${'a'.repeat(511)}🚀${'b'.repeat(10)}`;
    // The boundary moves back one char so the emoji stays whole in the second chunk.
    expect(c.countText(text)).toBe(
      c.countText('a'.repeat(511)) + c.countText(`🚀${'b'.repeat(10)}`),
    );
  });
});

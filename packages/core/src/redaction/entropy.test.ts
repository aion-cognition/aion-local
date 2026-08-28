import { describe, expect, it } from 'vitest';
import { findHighEntropyTokens, shannonEntropy } from './entropy.js';

describe('shannonEntropy', () => {
  it('is zero for the empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('is zero for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('is bounded by log2 of the alphabet size for a hex string', () => {
    // 40-char git-SHA-shaped hex string: max possible entropy is log2(16) = 4.0.
    expect(shannonEntropy('d2468bb14fd54d4d74a5f06c89961257ab5399d')).toBeLessThanOrEqual(4.0);
  });

  it('is higher for a mixed-case alphanumeric run than for prose', () => {
    const prose = shannonEntropy('the quick brown fox jumps over the lazy dog');
    const token = shannonEntropy('xK9$mQ2vN8pL4wR7tY1zB6cH3jF5nS0d');
    expect(token).toBeGreaterThan(prose);
  });
});

describe('findHighEntropyTokens', () => {
  const threshold = 4.5;

  it('flags a long random-looking token', () => {
    const text = 'leaked value: xK9mQ2vN8pL4wR7tY1zB6cH3jF5nS0dQ9wE2r';
    const spans = findHighEntropyTokens(text, threshold, []);
    expect(spans.length).toBeGreaterThan(0);
  });

  it('skips tokens shorter than the 20-char floor regardless of entropy', () => {
    const text = 'short: xK9mQ2vN8p';
    expect(findHighEntropyTokens(text, threshold, [])).toEqual([]);
  });

  it('skips a token whose span is already claimed', () => {
    const text = 'xK9mQ2vN8pL4wR7tY1zB6cH3jF5nS0dQ9wE2r';
    const claimed = [{ start: 0, end: text.length }];
    expect(findHighEntropyTokens(text, threshold, claimed)).toEqual([]);
  });

  it('lets a realistic kebab-case file path survive', () => {
    const text =
      'at /Users/rhuber/Documents/not-solace-code/aion_code/aion-local/packages/core/src/redaction/redact.ts';
    expect(findHighEntropyTokens(text, threshold, [])).toEqual([]);
  });
});

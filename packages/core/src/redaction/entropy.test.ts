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

  it('scans base64 material through its slashes instead of splitting on them', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const text = `the runbook still has ${secret} pasted beside it`;
    const spans = findHighEntropyTokens(text, threshold, []);

    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe(secret);
  });

  it('reaches the same verdict whichever case the name in an assignment was written in', () => {
    const value = 'AKIAABCDEFGHIJ23456';
    const upper = findHighEntropyTokens(`AWS_ACCESS_KEY_ID=${value}`, threshold, []);
    const lower = findHighEntropyTokens(`aws_access_key_id=${value}`, threshold, []);

    expect(upper).toEqual(lower);
    expect(upper).toHaveLength(1);
  });

  it('claims the value of an assignment and leaves the name it was keyed under', () => {
    const text = `AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJ23456`;
    const spans = findHighEntropyTokens(text, threshold, []);

    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe('AKIAABCDEFGHIJ23456');
  });

  it('claims the whole token when it carries no assignment to split', () => {
    const secret = 'xK9mQ2vN8pL4wR7tY1zB6cH3jF5nS0dQ9wE2r';
    const text = `leaked value: ${secret}`;
    const spans = findHighEntropyTokens(text, threshold, []);

    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe(secret);
  });

  it('flags an assignment whose name is in no credential vocabulary', () => {
    const text = 'SHELL_SESSION_ID=0123456789abcdef0123';
    const spans = findHighEntropyTokens(text, threshold, []);

    expect(text.slice(spans[0]?.start, spans[0]?.end)).toBe('0123456789abcdef0123');
  });
});

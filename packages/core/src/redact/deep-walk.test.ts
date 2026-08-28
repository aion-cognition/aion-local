import { describe, expect, it } from 'vitest';
import { redactPayload } from './deep-walk.js';

describe('redactPayload', () => {
  it('redacts a string field nested inside arrays and objects', () => {
    const payload = {
      turns: [{ role: 'user', text: 'my key is AKIAIOSFODNN7EXAMPLE, keep it safe' }],
      observations: ['nothing sensitive here'],
      summary: 'a session summary',
    };

    const result = redactPayload(payload);

    expect(result.value.turns[0]?.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.value.observations[0]).toBe('nothing sensitive here');
    expect(result.value.summary).toBe('a session summary');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.rule).toBe('aws-access-key');
  });

  it('leaves numbers, booleans, and null untouched', () => {
    const payload = { duration_ms: 8200, status: 'error', ok: false, note: null };
    const result = redactPayload(payload);
    expect(result.value).toEqual(payload);
    expect(result.matches).toEqual([]);
  });

  it('does not mutate the input payload', () => {
    const payload = { turns: [{ text: 'AKIAIOSFODNN7EXAMPLE' }] };
    const original = JSON.parse(JSON.stringify(payload));
    redactPayload(payload);
    expect(payload).toEqual(original);
  });

  it('threads a custom entropy threshold into every string field', () => {
    const payload = { note: 'password=abcdefgh' };
    const atDefault = redactPayload(payload);
    const atLowered = redactPayload(payload, 2.0);
    expect(atDefault.matches).toEqual([]);
    expect(atLowered.matches.length).toBeGreaterThan(0);
  });
});

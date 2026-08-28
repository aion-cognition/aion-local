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

  it('redacts a secret that arrives as an object key, at any depth', () => {
    const payload = {
      tool_executions: [
        {
          tool: 'bash',
          output: {
            AKIAIOSFODNN7EXAMPLE: 'active profile',
            tokens: { ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8: ['repo', 'workflow'] },
          },
        },
      ],
    };

    const result = redactPayload(payload);
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
    expect(serialized).toContain('⟨secret:aws-access-key:');
    expect(serialized).toContain('⟨secret:github-token:');
    expect(result.matches.map((match) => match.rule).sort()).toEqual([
      'aws-access-key',
      'github-token',
    ]);

    // The redacted key still addresses its own value, and unrelated keys are untouched.
    const output = (result.value.tool_executions[0] as { output: Record<string, unknown> }).output;
    expect(Object.values(output)).toContain('active profile');
    expect(Object.keys(output)).toContain('tokens');
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
    const payload = { note: 'the value was abcdeabcdeabcdeabcde in the log' };
    const atDefault = redactPayload(payload);
    const atLowered = redactPayload(payload, 2.0);
    expect(atDefault.matches).toEqual([]);
    expect(atLowered.matches.length).toBeGreaterThan(0);
  });
});

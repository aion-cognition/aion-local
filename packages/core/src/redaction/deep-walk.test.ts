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

  it('reads an object key as context for its own value, at any depth', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const payload = {
      tool_executions: [
        {
          tool: 'exec_shell',
          input: { command: 'env', context: { nested: { aws_secret_access_key: secret } } },
        },
      ],
    };

    const result = redactPayload(payload);
    const serialized = JSON.stringify(result.value);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('⟨secret:aws-secret-key:');
    expect(result.matches.map((match) => match.rule)).toEqual(['aws-secret-key']);
  });

  it('fingerprints a credential field whose value trips no rule on its own', () => {
    const value = 'Zt7pQ4mX9wL2';

    // Twelve characters, no vendor prefix, under the entropy backstop's length floor: as a
    // bare string it is indistinguishable from an identifier, and only its key names it.
    expect(redactPayload({ note: value }).matches).toEqual([]);

    const result = redactPayload({ output: { db_password_prod: value } });
    expect(JSON.stringify(result.value)).not.toContain(value);
    expect(result.matches.map((match) => match.rule)).toEqual(['generic-secret-assignment']);
  });

  it('reads a credential key at name-segment boundaries, not as a substring', () => {
    const result = redactPayload({
      output: { myPassword: 'Zt7pQ4mX9wL2', tokenizer: 'bert-base-uncased' },
    });

    expect(result.value.output.tokenizer).toBe('bert-base-uncased');
    expect(result.value.output.myPassword).not.toContain('Zt7pQ4mX9wL2');
    expect(result.matches).toHaveLength(1);
  });

  it('carries the credential key through an array of values', () => {
    const result = redactPayload({ output: { tokens: ['b7f31ba29c4e6d18', 'a01f3c8de29b7415'] } });

    expect(JSON.stringify(result.value)).not.toContain('b7f31ba29c4e6d18');
    expect(JSON.stringify(result.value)).not.toContain('a01f3c8de29b7415');
    expect(result.matches).toHaveLength(2);
  });

  it('stops carrying the credential key at the next object', () => {
    const result = redactPayload({ secrets: { rotation_note: 'rotate before the next deploy' } });

    expect(result.value.secrets.rotation_note).toBe('rotate before the next deploy');
    expect(result.matches).toEqual([]);
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

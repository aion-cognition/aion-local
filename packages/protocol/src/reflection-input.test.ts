import { describe, expect, it } from 'vitest';

import { ReflectionInputSchema } from './reflection-input.js';

describe('ReflectionInputSchema valid fixtures', () => {
  it('parses turns alone', () => {
    const input = { turns: [{ role: 'user', text: 'why webhooks?' }] };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses tool_executions alone', () => {
    const input = {
      tool_executions: [
        { tool: 'bash', input: 'npm test', status: 'error', output: 'FAIL', duration_ms: 8200 },
      ],
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses observations alone', () => {
    const input = { observations: ['We decided to key the sync on id_slug because …'] };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses all three buckets plus summary and session_id', () => {
    const input = {
      turns: [{ role: 'user', text: 'hi' }],
      tool_executions: [
        { tool: 'bash', input: 'npm test', status: 'error', output: '…', duration_ms: 8200 },
      ],
      observations: ['decided to key the sync on id_slug'],
      summary: 'optional episode summary',
      session_id: 'session-abc',
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses an explicit bulk lane', () => {
    const input = { observations: ['a batch import'], lane: 'bulk' };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('rejects a lane outside the vocabulary', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: ['a decision'],
      lane: 'urgent',
    });
    expect(result.success).toBe(false);
  });

  it('parses a per-item occurred_at on a turn and a tool_execution', () => {
    const input = {
      turns: [{ role: 'user', text: 'hi', occurred_at: '2026-02-14' }],
      tool_executions: [
        {
          tool: 'bash',
          input: 'npm test',
          status: 'success',
          output: 'ok',
          duration_ms: 100,
          occurred_at: '2026-02-14T09:00:00Z',
        },
      ],
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses a tool_execution carrying only what the agent captured', () => {
    const input = { tool_executions: [{ tool: 'bash', status: 'ok' }] };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses a tool_execution with an input but no output and no timing', () => {
    const input = { tool_executions: [{ tool: 'read', input: 'src/index.ts', status: 'ok' }] };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses an origin naming a channel and an event', () => {
    const input = {
      observations: ['a decision'],
      origin: { channel: 'hook', event: 'stop' },
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('parses an origin with no event', () => {
    const input = { observations: ['a decision'], origin: { channel: 'cli' } };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('rejects an origin channel outside the vocabulary', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: ['a decision'],
      origin: { channel: 'browser' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key on origin', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: ['a decision'],
      origin: { channel: 'mcp', transport: 'http' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a non-standard tool_execution status', () => {
    const input = {
      tool_executions: [
        { tool: 'bash', input: 'x', status: 'timeout', output: null, duration_ms: 1 },
      ],
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });
});

describe('ReflectionInputSchema at-least-one rule', () => {
  it('rejects a payload with none of turns/tool_executions/observations', () => {
    const result = ReflectionInputSchema.safeParse({ summary: 'just a summary', session_id: 's1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one/);
    }
  });

  it('rejects an entirely empty payload', () => {
    expect(ReflectionInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects when every present bucket is an empty array', () => {
    const result = ReflectionInputSchema.safeParse({
      turns: [],
      tool_executions: [],
      observations: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts when only one bucket is non-empty among several present keys', () => {
    const input = { turns: [], observations: ['a decision'], tool_executions: [] };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });
});

describe('ReflectionInputSchema invalid shapes', () => {
  it('rejects a turn missing text', () => {
    const result = ReflectionInputSchema.safeParse({ turns: [{ role: 'user' }] });
    expect(result.success).toBe(false);
  });

  it('rejects a negative duration_ms', () => {
    const result = ReflectionInputSchema.safeParse({
      tool_executions: [
        { tool: 'bash', input: 'x', status: 'error', output: 'x', duration_ms: -1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string observation', () => {
    const result = ReflectionInputSchema.safeParse({ observations: [''] });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed occurred_at on a turn', () => {
    const result = ReflectionInputSchema.safeParse({
      turns: [{ role: 'user', text: 'hi', occurred_at: 'yesterday' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: ['a decision'],
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

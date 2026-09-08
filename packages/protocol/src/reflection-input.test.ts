import { describe, expect, it } from 'vitest';

import {
  MAX_REFLECTION_OBSERVATIONS,
  MAX_REFLECTION_REQUEST_BYTES,
  MAX_REFLECTION_TOOL_EXECUTIONS,
  MAX_REFLECTION_TURNS,
  ReflectionInputSchema,
  reflectionBoundsBreaches,
} from './reflection-input.js';

function turns(count: number): { role: string; text: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    role: 'user',
    text: `turn ${String(index)}`,
  }));
}

function observations(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `observation ${String(index)}`);
}

function toolExecutions(count: number): { tool: string; status: string }[] {
  return Array.from({ length: count }, () => ({ tool: 'bash', status: 'ok' }));
}

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

  it('rejects the verification channel, which no caller produces', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: ['a decision'],
      origin: { channel: 'verification' },
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

describe('new-request bounds', () => {
  it('accepts a request at every count bound', () => {
    const input = {
      turns: turns(MAX_REFLECTION_TURNS),
      tool_executions: toolExecutions(MAX_REFLECTION_TOOL_EXECUTIONS),
      observations: observations(MAX_REFLECTION_OBSERVATIONS),
    };
    expect(ReflectionInputSchema.parse(input)).toEqual(input);
  });

  it('rejects one turn past the bound', () => {
    const result = ReflectionInputSchema.safeParse({ turns: turns(MAX_REFLECTION_TURNS + 1) });
    expect(result.success).toBe(false);
  });

  it('rejects one tool execution past the bound', () => {
    const result = ReflectionInputSchema.safeParse({
      tool_executions: toolExecutions(MAX_REFLECTION_TOOL_EXECUTIONS + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects one observation past the bound', () => {
    const result = ReflectionInputSchema.safeParse({
      observations: observations(MAX_REFLECTION_OBSERVATIONS + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload past the byte bound and truncates nothing', () => {
    const oversized = { observations: ['x'.repeat(MAX_REFLECTION_REQUEST_BYTES)] };
    const result = ReflectionInputSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    expect(oversized.observations[0]).toHaveLength(MAX_REFLECTION_REQUEST_BYTES);
  });

  it('names every bound an archived payload exceeds without altering it', () => {
    const legacy = {
      turns: turns(MAX_REFLECTION_TURNS + 5),
      observations: observations(MAX_REFLECTION_OBSERVATIONS + 1),
    };
    expect(reflectionBoundsBreaches(legacy)).toEqual([
      { bound: 'turns', limit: MAX_REFLECTION_TURNS, actual: MAX_REFLECTION_TURNS + 5 },
      {
        bound: 'observations',
        limit: MAX_REFLECTION_OBSERVATIONS,
        actual: MAX_REFLECTION_OBSERVATIONS + 1,
      },
    ]);
    expect(legacy.turns).toHaveLength(MAX_REFLECTION_TURNS + 5);
  });

  it('reports nothing for a payload inside every bound', () => {
    expect(reflectionBoundsBreaches({ observations: ['a decision'] })).toEqual([]);
  });
});

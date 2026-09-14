import { describe, expect, it } from 'vitest';

import {
  isReflectionRefusal,
  ReflectionOutputSchema,
  ReflectionRefusalSchema,
  ReflectionResultSchema,
  type ReflectionResult,
} from './reflection-output.js';

describe('ReflectionOutputSchema valid fixtures', () => {
  it('parses the shape with the assigned lane', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'interactive' };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });

  it('parses a bulk ack', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'bulk' };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });

  it('parses an ack carrying pending_ahead', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'interactive', pending_ahead: 3 };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });

  it('parses an ack with pending_ahead absent, for a build that predates it', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'interactive' };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });
});

describe('ReflectionOutputSchema invalid shapes', () => {
  it('rejects queued: false, since intake never reports synchronous completion', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: 'episode-1',
      queued: false,
      lane: 'interactive',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing episode_id', () => {
    const result = ReflectionOutputSchema.safeParse({ queued: true, lane: 'interactive' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty episode_id', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: '',
      queued: true,
      lane: 'interactive',
    });
    expect(result.success).toBe(false);
  });

  // The ack is the only place a caller learns its episode was demoted behind a bulk load, so
  // an ack that omits the lane is not a valid ack.
  it('rejects an ack with no lane', () => {
    const result = ReflectionOutputSchema.safeParse({ episode_id: 'e1', queued: true });
    expect(result.success).toBe(false);
  });

  it('rejects a lane outside the vocabulary', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: 'e1',
      queued: true,
      lane: 'urgent',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative pending_ahead', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: 'e1',
      queued: true,
      lane: 'interactive',
      pending_ahead: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: 'e1',
      queued: true,
      lane: 'interactive',
      extra: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ReflectionOutputSchema pre_birth_trim', () => {
  it('parses an ack that discloses a partial birth-fence trim', () => {
    const output = {
      episode_id: 'episode-1',
      queued: true,
      lane: 'interactive',
      pre_birth_trim: { turns: 1, tool_executions: 0 },
    };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });

  it('rejects a negative count inside pre_birth_trim', () => {
    const result = ReflectionOutputSchema.safeParse({
      episode_id: 'episode-1',
      queued: true,
      lane: 'interactive',
      pre_birth_trim: { turns: -1, tool_executions: 0 },
    });
    expect(result.success).toBe(false);
  });
});

const REFUSAL = {
  status: 'pre_birth_refusal' as const,
  substrate_born_at: '2026-09-14T10:07:37.000Z',
  pre_birth_refused: { turns: 2, tool_executions: 0 },
};

describe('ReflectionRefusalSchema', () => {
  it('parses a full pre-birth refusal', () => {
    expect(ReflectionRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
  });

  it('rejects a status outside the one refusal reason this protocol names', () => {
    const result = ReflectionRefusalSchema.safeParse({ ...REFUSAL, status: 'coverage_refusal' });
    expect(result.success).toBe(false);
  });

  it('rejects a refusal missing substrate_born_at', () => {
    const result = ReflectionRefusalSchema.safeParse({
      status: REFUSAL.status,
      pre_birth_refused: REFUSAL.pre_birth_refused,
    });
    expect(result.success).toBe(false);
  });
});

describe('ReflectionResultSchema and isReflectionRefusal', () => {
  it('accepts either branch', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'interactive' };
    expect(ReflectionResultSchema.safeParse(output).success).toBe(true);
    expect(ReflectionResultSchema.safeParse(REFUSAL).success).toBe(true);
  });

  it('tells the branches apart on status alone', () => {
    const output: ReflectionResult = { episode_id: 'episode-1', queued: true, lane: 'interactive' };
    expect(isReflectionRefusal(output)).toBe(false);
    expect(isReflectionRefusal(REFUSAL)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ReflectionOutputSchema } from './reflection-output.js';

describe('ReflectionOutputSchema valid fixtures', () => {
  it('parses the PRD §3.2 shape with the assigned lane', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'interactive' };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });

  it('parses a bulk ack', () => {
    const output = { episode_id: 'episode-1', queued: true, lane: 'bulk' };
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

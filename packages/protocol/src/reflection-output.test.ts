import { describe, expect, it } from 'vitest';
import { ReflectionOutputSchema } from './reflection-output.js';

describe('ReflectionOutputSchema valid fixtures', () => {
  it('parses the PRD §3.2 shape', () => {
    const output = { episode_id: 'episode-1', queued: true };
    expect(ReflectionOutputSchema.parse(output)).toEqual(output);
  });
});

describe('ReflectionOutputSchema invalid shapes', () => {
  it('rejects queued: false, since intake never reports synchronous completion', () => {
    const result = ReflectionOutputSchema.safeParse({ episode_id: 'episode-1', queued: false });
    expect(result.success).toBe(false);
  });

  it('rejects a missing episode_id', () => {
    const result = ReflectionOutputSchema.safeParse({ queued: true });
    expect(result.success).toBe(false);
  });

  it('rejects an empty episode_id', () => {
    const result = ReflectionOutputSchema.safeParse({ episode_id: '', queued: true });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field', () => {
    const result = ReflectionOutputSchema.safeParse({ episode_id: 'e1', queued: true, extra: 1 });
    expect(result.success).toBe(false);
  });
});

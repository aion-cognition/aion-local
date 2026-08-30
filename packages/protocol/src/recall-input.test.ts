import { describe, expect, it } from 'vitest';

import { RecallInputSchema } from './recall-input.js';

describe('RecallInputSchema valid fixtures', () => {
  it('parses the minimal input: query only', () => {
    const result = RecallInputSchema.parse({ query: 'why did we pick webhooks?' });
    expect(result).toEqual({ query: 'why did we pick webhooks?' });
  });

  it('parses all fields', () => {
    const input = {
      query: 'why did we pick webhooks for the ingestion service?',
      context: {
        summary: '1-2 paragraph rolling summary of the conversation',
        recent_turns: [{ role: 'user', text: 'why webhooks and not polling?' }],
      },
      budget: { max_tokens: 1200 },
      session_id: 'session-abc',
      as_of: '2026-03-01',
      knew_at: '2026-03-01',
    };
    expect(RecallInputSchema.parse(input)).toEqual(input);
  });

  it('accepts a full ISO datetime for as_of/knew_at, not just a bare date', () => {
    const input = {
      query: 'q',
      as_of: '2026-03-01T12:30:00Z',
      knew_at: '2026-03-01T12:30:00-05:00',
    };
    expect(RecallInputSchema.parse(input)).toEqual(input);
  });

  it('accepts a non-standard role string', () => {
    const input = {
      query: 'q',
      context: { recent_turns: [{ role: 'system', text: 'grounding note' }] },
    };
    expect(RecallInputSchema.parse(input)).toEqual(input);
  });
});

describe('RecallInputSchema invalid shapes', () => {
  it('rejects a missing query', () => {
    const result = RecallInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty query', () => {
    const result = RecallInputSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed as_of', () => {
    const result = RecallInputSchema.safeParse({ query: 'q', as_of: '03/01/2026' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed knew_at', () => {
    const result = RecallInputSchema.safeParse({ query: 'q', knew_at: 'not a date' });
    expect(result.success).toBe(false);
  });

  it('rejects a budget without max_tokens', () => {
    const result = RecallInputSchema.safeParse({ query: 'q', budget: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive max_tokens', () => {
    const result = RecallInputSchema.safeParse({ query: 'q', budget: { max_tokens: 0 } });
    expect(result.success).toBe(false);
  });

  it('rejects a recent_turns entry missing text', () => {
    const result = RecallInputSchema.safeParse({
      query: 'q',
      context: { recent_turns: [{ role: 'user' }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = RecallInputSchema.safeParse({ query: 'q', unexpected_field: true });
    expect(result.success).toBe(false);
  });
});

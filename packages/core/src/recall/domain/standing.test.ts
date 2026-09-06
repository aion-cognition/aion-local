import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { standingFor } from './standing.js';

function item(labels: readonly string[], overrides: Partial<FusedItem> = {}): FusedItem {
  return {
    id: 'n1',
    labels,
    content: 'the ingest queue holds 4.2 million rows',
    rationale: { method: 'vector', score: 0.6 },
    relevance: 0.6,
    measured: 0.6,
    score: 0.02,
    currency: 'current',
    ...overrides,
  };
}

describe('what kind of statement an item is', () => {
  it('tells a stored utterance apart from a reading of one', () => {
    expect(standingFor(item(['Turn', 'Memory', 'AionNode'])).kind).toBe('recorded_utterance');
    expect(standingFor(item(['Insight', 'Memory', 'AionNode'])).kind).toBe(
      'extracted_interpretation',
    );
  });

  it('gives a decision its own kind rather than folding it in with every other claim', () => {
    expect(standingFor(item(['Decision', 'Memory', 'AionNode'])).kind).toBe('recorded_decision');
  });

  it('separates a capture, a synthesis, and a description', () => {
    expect(standingFor(item(['Episode', 'Memory', 'AionNode'])).kind).toBe('recorded_session');
    expect(standingFor(item(['Narrative', 'Memory', 'AionNode'])).kind).toBe('synthesized');
    expect(standingFor(item(['Entity', 'Memory', 'AionNode'])).kind).toBe('stated_description');
  });
});

describe('how far an item can be attributed', () => {
  it('reads a recorded role as a report and never as a person', () => {
    const standing = standingFor(item(['Turn', 'Memory', 'AionNode']), {
      roots: [],
      complete: true,
      recordedRole: 'user',
    });

    expect(standing.attribution).toBe('reported');
    expect(standing.recorded_role).toBe('user');
    expect(standing.confirmed).toBeUndefined();
  });

  it('says unknown when capture recorded no role at all', () => {
    const standing = standingFor(item(['Turn', 'Memory', 'AionNode']));

    expect(standing.attribution).toBe('unknown');
    expect(standing.recorded_role).toBeUndefined();
  });

  it('attributes only against a confirmation record that names its evidence', () => {
    const standing = standingFor(item(['Insight', 'Memory', 'AionNode']), {
      roots: [],
      complete: true,
      confirmation: {
        by: 'Ryan Huber',
        at: new Date('2026-09-01T10:00:00.000Z'),
        evidence: 'review thread 41',
      },
    });

    expect(standing.attribution).toBe('attributed');
    expect(standing.confirmed).toEqual({
      by: 'Ryan Huber',
      at: '2026-09-01T10:00:00.000Z',
      evidence: 'review thread 41',
    });
  });

  it('leaves a role-carrying item reported even beside a high retrieval score', () => {
    const standing = standingFor(
      item(['Turn', 'Memory', 'AionNode'], { measured: 0.99, score: 0.99 }),
      { roots: [], complete: true, recordedRole: 'user' },
    );

    expect(standing.attribution).toBe('reported');
  });
});

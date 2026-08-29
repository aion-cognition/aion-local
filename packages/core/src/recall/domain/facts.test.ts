import type { Cue } from '@aion/protocol';
import { describe, expect, it } from 'vitest';
import type { Measurement } from './admission.js';
import {
  hasDecisionIntent,
  labelBoosts,
  queryCueTexts,
  queryRestatements,
  type RestatementCandidate,
} from './facts.js';

const QUERY = 'what did we decide about how the remittance files get ingested';

const POLICY = { floor: 0.8, queryCues: new Set([QUERY]) };

function candidate(
  id: string,
  labels: readonly string[],
  evidence: readonly Measurement[],
): RestatementCandidate {
  return { id, labels, evidence };
}

function vectorHit(relevance: number, cue = QUERY): Measurement {
  return { method: 'vector', relevance, cue };
}

describe('query restatements', () => {
  it('names a Goal that scores at the floor against the query', () => {
    const restating = queryRestatements(
      [candidate('goal', ['Goal', 'Memory'], [vectorHit(0.92)])],
      POLICY,
    );

    expect([...restating]).toEqual(['goal']);
  });

  it('names a Plan on the same rule, since a plan can restate a question too', () => {
    const restating = queryRestatements(
      [candidate('plan', ['Plan', 'Memory'], [vectorHit(0.85)])],
      POLICY,
    );

    expect([...restating]).toEqual(['plan']);
  });

  it('leaves a Goal that answers the query alone', () => {
    const restating = queryRestatements(
      [candidate('goal', ['Goal', 'Memory'], [vectorHit(0.72)])],
      POLICY,
    );

    expect(restating.size).toBe(0);
  });

  it('never touches a Decision, however well it scores', () => {
    const restating = queryRestatements(
      [
        candidate('decision', ['Decision', 'Memory'], [vectorHit(0.99)]),
        candidate('insight', ['Insight', 'Memory'], [vectorHit(0.99)]),
        candidate('entity', ['Entity', 'Memory'], [vectorHit(0.99)]),
        candidate('episode', ['Episode', 'Memory'], [vectorHit(0.99)]),
      ],
      POLICY,
    );

    expect(restating.size).toBe(0);
  });

  it('ignores a hit against a cue the query did not produce', () => {
    const restating = queryRestatements(
      [candidate('goal', ['Goal'], [vectorHit(0.95, 'reviewing my own recent work')])],
      POLICY,
    );

    expect(restating.size).toBe(0);
  });

  // A Lucene score is corpus-relative, so it cannot be compared against a cosine floor.
  it('ignores a lexical hit at any score', () => {
    const restating = queryRestatements(
      [candidate('goal', ['Goal'], [{ method: 'bm25', relevance: 1, cue: QUERY, exact: true }])],
      POLICY,
    );

    expect(restating.size).toBe(0);
  });

  it('leaves a Goal nothing measured against the query alone', () => {
    const restating = queryRestatements([{ id: 'goal', labels: ['Goal'] }], POLICY);

    expect(restating.size).toBe(0);
  });
});

describe('the query cue set', () => {
  it('collects the model cues and the raw-query cue, and nothing else', () => {
    const cues: readonly Cue[] = [
      { text: 'remittance ingest', source: 'query', weight: 3 },
      { text: QUERY, source: 'raw_query', weight: 3 },
      { text: 'ingestion service rollout', source: 'summary', weight: 2 },
      { text: 'did the dry run pass', source: 'recent_turns', weight: 1 },
    ];

    expect([...queryCueTexts(cues)]).toEqual(['remittance ingest', QUERY]);
  });
});

describe('the decision-intent boost', () => {
  const decisionCue: Cue = { text: QUERY, source: 'query', weight: 3, intent: 'decision' };
  const plainCue: Cue = { text: 'how long does the migration take', source: 'query', weight: 3 };

  it('boosts Decision and Insight when the model judged the query decision-shaped', () => {
    expect(labelBoosts([decisionCue, plainCue], 1.25)).toEqual({ Decision: 1.25, Insight: 1.25 });
    expect(hasDecisionIntent([decisionCue])).toBe(true);
  });

  it('boosts nothing on a query with no judged intent', () => {
    expect(labelBoosts([plainCue], 1.25)).toEqual({});
    expect(hasDecisionIntent([plainCue])).toBe(false);
  });
});

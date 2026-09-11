import { beforeAll, describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { config, deps, harness, provider, RECALLED_AT } from './test-support/recall-int.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { foldName } from '../../reflection/domain/name-fold.js';

/**
 * The third way into a pack: a standing intention nobody asked about, brought back because the
 * thing it is about is in play. The goal below is written with no content vector and no words
 * the query shares, so no retrieval leg can reach it; the only path into the pack is its own
 * trigger.
 */
describe('intentions the recall brings back on their own trigger', () => {
  const TRIGGER_SESSION = 'recall-int-trigger-session';
  const ENTITY_NAME = 'Ledger Rewrite';
  const ENTITY_ID = 'entity-ledger-rewrite';
  const GOAL_EPISODE_ID = 'episode-ledger-goal';
  const GOAL_TEXT = 'circle back on the freeze once the quarter closes';
  const TRIGGER_QUERY = `where are we with ${ENTITY_NAME}`;
  /** Stamped before every other fixture node, so the recency strategy never seeds the goal. */
  const SEEDED_AT = new Date('2026-05-02T00:00:00.000Z');

  let goalId: string;
  let triggerDeps: RecallDeps;

  beforeAll(async () => {
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id: ENTITY_ID,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: { name: ENTITY_NAME, name_norm: foldName(ENTITY_NAME), type: 'project' },
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: GOAL_EPISODE_ID,
      now: SEEDED_AT,
      occurredAt: SEEDED_AT,
      properties: { text: 'a session about the freeze', session_id: 'session-ledger' },
    });
    const written = await writeCognitiveNode(harness.driver, {
      episodeId: GOAL_EPISODE_ID,
      label: 'Goal',
      text: GOAL_TEXT,
      subjectEntityId: ENTITY_ID,
      occurredAt: SEEDED_AT,
      now: SEEDED_AT,
      // A horizon well past the reading clock: an expired intention never triggers.
      intentionHorizonDays: 365,
    });
    goalId = written.node.id;

    triggerDeps = {
      ...deps,
      config: {
        ...config(),
        // The one place this file wants the repeat subtraction on: a trigger that fires every
        // call would nag, and dedup is what stops it.
        recall: { ...config().recall, sessionDedup: true, tokenBudget: 4000 },
        contextResonance: { ...DEFAULTS.contextResonance, seedLimit: 5 },
      },
      provider: {
        embed: (texts) => provider.embed(texts),
        generate: () =>
          Promise.resolve({ query_cues: [ENTITY_NAME], summary_cues: [], recent_turn_cues: [] }),
      },
      cueCache: new CueCache(),
    };
  }, 60_000);

  it('serves a standing intention when the entity it is about is in play', async () => {
    const pack = await handleRecall(
      triggerDeps,
      { query: TRIGGER_QUERY },
      { identity: TRIGGER_SESSION, now: RECALLED_AT },
    );

    const served = pack.intentions?.find((item) => item.id === goalId);
    expect(served?.content).toBe(GOAL_TEXT);
    expect(served?.rationale.method).toBe('intention_trigger');
    expect(pack.rendered_text).toContain('## Intentions');
    // The trigger is the only way in: no other bucket holds it.
    expect(pack.facts?.map((item) => item.id)).not.toContain(goalId);
  });

  it('says it once: the same session asking again is not reminded twice', async () => {
    const repeat = await handleRecall(
      triggerDeps,
      { query: TRIGGER_QUERY },
      { identity: TRIGGER_SESSION, now: RECALLED_AT },
    );

    expect(repeat.intentions).toBeUndefined();
    expect(repeat.metadata.suppressed_repeats).toBeGreaterThan(0);
  });

  /**
   * Asking what the substrate held at another moment is a question about the past. A trigger is
   * the substrate acting now, so a time-traveled read evaluates none of them.
   */
  it('evaluates no trigger on a time-traveled read', async () => {
    const pack = await handleRecall(
      triggerDeps,
      { query: TRIGGER_QUERY, as_of: RECALLED_AT.toISOString() },
      { identity: 'recall-int-trigger-history', now: RECALLED_AT },
    );

    expect(pack.intentions).toBeUndefined();
  });
});

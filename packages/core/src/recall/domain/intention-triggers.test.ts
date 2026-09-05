import { describe, expect, it } from 'vitest';

import {
  INTENTION_TRIGGER_METHOD,
  INTENTION_TRIGGER_PATHS,
  matchIntentionTriggers,
  triggeredIntentionItem,
  type IntentionTriggerContext,
} from './intention-triggers.js';
import type { TriggerableIntention } from '../../infrastructure/graph/intention-queries.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';

const NOW = new Date('2026-10-05T09:00:00.000Z');

const BEFORE_NOW = new Date('2026-10-01T00:00:00.000Z');

const AFTER_NOW = new Date('2026-11-01T00:00:00.000Z');

/** Cosine 0.6 against the centroid below, which is the floor every boundary case is written on. */
const SIXTY_PERCENT: readonly number[] = [3, 4];

const CENTROID: readonly number[] = [1, 0];

function context(overrides: Partial<IntentionTriggerContext> = {}): IntentionTriggerContext {
  return {
    activatedIds: new Set<string>(),
    now: NOW,
    situationFloor: 0.6,
    limit: 3,
    ...overrides,
  };
}

describe('matchIntentionTriggers', () => {
  it('fires on the subject entity the spread reached', () => {
    const intention: TriggerableIntention = { id: 'goal-1', subjectEntityId: 'entity-postgres' };

    const matches = matchIntentionTriggers([intention], {
      ...context({ activatedIds: new Set(['entity-postgres']) }),
    });

    expect(matches).toEqual([{ id: 'goal-1', kind: 'entity', score: 1 }]);
  });

  it('leaves an intention alone when the thing it is about is not in play', () => {
    const intention: TriggerableIntention = { id: 'goal-1', subjectEntityId: 'entity-postgres' };

    expect(
      matchIntentionTriggers([intention], context({ activatedIds: new Set(['other']) })),
    ).toEqual([]);
  });

  it('fires on a date that has passed and not on one still ahead', () => {
    const due: TriggerableIntention = { id: 'plan-due', triggerAfter: BEFORE_NOW };
    const waiting: TriggerableIntention = { id: 'plan-waiting', triggerAfter: AFTER_NOW };

    const matches = matchIntentionTriggers([due, waiting], context());

    expect(matches).toEqual([{ id: 'plan-due', kind: 'temporal', score: 1 }]);
  });

  it('fires on a situation at the floor and refuses the same one under it', () => {
    const intention: TriggerableIntention = { id: 'goal-1', triggerVector: SIXTY_PERCENT };

    const atFloor = matchIntentionTriggers(
      [intention],
      context({ centroid: CENTROID, situationFloor: 0.6 }),
    );
    const underFloor = matchIntentionTriggers(
      [intention],
      context({ centroid: CENTROID, situationFloor: 0.61 }),
    );

    expect(atFloor).toEqual([{ id: 'goal-1', kind: 'situation', score: 0.6 }]);
    expect(underFloor).toEqual([]);
  });

  /**
   * The second pass declines to run on a query that anchored nothing, and on a substrate whose
   * context vectors are still pending. Neither is a reason to withhold the two conditions that
   * need no centroid at all.
   */
  it('drops the situation trigger with no centroid and keeps the other two', () => {
    const situation: TriggerableIntention = { id: 'goal-shape', triggerVector: SIXTY_PERCENT };
    const entity: TriggerableIntention = { id: 'goal-subject', subjectEntityId: 'entity-1' };
    const temporal: TriggerableIntention = { id: 'plan-date', triggerAfter: BEFORE_NOW };

    const matches = matchIntentionTriggers(
      [situation, entity, temporal],
      context({ activatedIds: new Set(['entity-1']) }),
    );

    expect(matches.map((match) => match.id)).toEqual(['goal-subject', 'plan-date']);
  });

  it('reports the narrowest condition an intention meets, not every one of them', () => {
    const intention: TriggerableIntention = {
      id: 'goal-1',
      subjectEntityId: 'entity-1',
      triggerAfter: BEFORE_NOW,
      triggerVector: SIXTY_PERCENT,
    };

    const matches = matchIntentionTriggers(
      [intention],
      context({ activatedIds: new Set(['entity-1']), centroid: CENTROID }),
    );

    expect(matches).toEqual([{ id: 'goal-1', kind: 'entity', score: 1 }]);
  });

  it('orders the kinds narrowest first, whatever order they were read in', () => {
    const situation: TriggerableIntention = { id: 'goal-shape', triggerVector: SIXTY_PERCENT };
    const temporal: TriggerableIntention = { id: 'plan-date', triggerAfter: BEFORE_NOW };
    const entity: TriggerableIntention = { id: 'goal-subject', subjectEntityId: 'entity-1' };

    const matches = matchIntentionTriggers(
      [situation, temporal, entity],
      context({ activatedIds: new Set(['entity-1']), centroid: CENTROID }),
    );

    expect(matches.map((match) => match.kind)).toEqual(['entity', 'temporal', 'situation']);
  });

  it('caps what it returns, keeping the narrowest triggers', () => {
    const intentions: TriggerableIntention[] = [
      { id: 'plan-a', triggerAfter: BEFORE_NOW },
      { id: 'plan-b', triggerAfter: BEFORE_NOW },
      { id: 'goal-subject', subjectEntityId: 'entity-1' },
    ];

    const matches = matchIntentionTriggers(
      intentions,
      context({ activatedIds: new Set(['entity-1']), limit: 2 }),
    );

    expect(matches.map((match) => match.id)).toEqual(['goal-subject', 'plan-a']);
  });

  it('returns nothing at all when the bucket holds nothing', () => {
    const intention: TriggerableIntention = { id: 'plan-a', triggerAfter: BEFORE_NOW };

    expect(matchIntentionTriggers([intention], context({ limit: 0 }))).toEqual([]);
  });

  /**
   * An intention the query itself found is already in the pack, in the bucket its label routes
   * it to. Serving it a second time under a trigger explains it with neither rationale.
   */
  it('leaves out an intention the run already produced, before the cap is applied', () => {
    const intentions: TriggerableIntention[] = [
      { id: 'plan-served', triggerAfter: BEFORE_NOW },
      { id: 'plan-new', triggerAfter: BEFORE_NOW },
    ];

    const matches = matchIntentionTriggers(
      intentions,
      context({ limit: 1, exclude: new Set(['plan-served']) }),
    );

    expect(matches.map((match) => match.id)).toEqual(['plan-new']);
  });
});

describe('triggeredIntentionItem', () => {
  const candidate: SeedCandidate = {
    id: 'goal-1',
    labels: ['Goal', 'Memory', 'AionNode'],
    content: 'move every queue write off Postgres',
    currency: 'current',
  };

  it('explains itself by the trigger that fired rather than by a retrieval method', () => {
    const item = triggeredIntentionItem(candidate, {
      id: 'goal-1',
      kind: 'entity',
      score: 1,
    });

    expect(item.rationale).toEqual({
      method: INTENTION_TRIGGER_METHOD,
      score: 1,
      path: INTENTION_TRIGGER_PATHS.entity,
    });
  });

  /**
   * The admission rules are the content floors and the context threshold, and none of them
   * judged this item: nothing measured it against the query at all.
   */
  it('claims no admission rule, because no rule admitted it', () => {
    const item = triggeredIntentionItem(candidate, { id: 'goal-1', kind: 'situation', score: 0.6 });

    expect(item.admittedBy).toBeUndefined();
    expect(item.measured).toBe(0.6);
    expect(item.currency).toBe('current');
  });
});

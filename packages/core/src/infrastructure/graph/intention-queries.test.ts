import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY } from './bitemporal.js';
import { GraphWriteError } from './errors.js';
import {
  buildCloseStaleIntentionsStatement,
  buildStaleIntentionsStatement,
  CLOSED_BY_INTENTION_UPKEEP,
  INTENTION_NODE_LABELS,
  INTENTION_ORIGIN_PROPERTY,
  intentionProperties,
  isIntentionNodeLabel,
} from './intention-queries.js';
import { VALID_HORIZON_PROPERTY } from './read-modes.js';
import { FACT_NODE_LABELS } from './supersession-queries.js';

const NOW = new Date('2026-10-05T00:00:00.000Z');

const STALE_BEFORE = new Date('2026-09-05T00:00:00.000Z');

const OCCURRED_AT = new Date('2026-09-01T12:00:00.000Z');

describe('INTENTION_NODE_LABELS', () => {
  it('is exactly Goal and Plan', () => {
    expect(INTENTION_NODE_LABELS).toEqual(['Goal', 'Plan']);
  });

  it('shares no label with the fact set the judged supersession scan watches', () => {
    const facts = new Set<string>(FACT_NODE_LABELS);
    for (const label of INTENTION_NODE_LABELS) {
      expect(facts.has(label)).toBe(false);
    }
  });

  it('recognizes an intention label and refuses every other cognitive type', () => {
    expect(isIntentionNodeLabel('Goal')).toBe(true);
    expect(isIntentionNodeLabel('Plan')).toBe(true);
    expect(isIntentionNodeLabel('Decision')).toBe(false);
    expect(isIntentionNodeLabel('Concept')).toBe(false);
  });
});

describe('intentionProperties', () => {
  it('writes nothing for a label that states a fact rather than an intention', () => {
    expect(
      intentionProperties({
        label: 'Decision',
        occurredAt: OCCURRED_AT,
        horizonDays: 30,
        originKind: 'substrate',
      }),
    ).toEqual({});
  });

  it('dates the horizon from the episode clock rather than the write clock', () => {
    const properties = intentionProperties({
      label: 'Goal',
      occurredAt: OCCURRED_AT,
      horizonDays: 30,
    });

    expect(properties[VALID_HORIZON_PROPERTY]).toEqual(new Date('2026-10-01T12:00:00.000Z'));
  });

  it('omits the origin for a member intention, which is what every extracted one is', () => {
    const defaulted = intentionProperties({ label: 'Plan', occurredAt: OCCURRED_AT });
    const explicit = intentionProperties({
      label: 'Plan',
      occurredAt: OCCURRED_AT,
      originKind: 'member',
    });

    expect(defaulted[INTENTION_ORIGIN_PROPERTY]).toBeUndefined();
    expect(explicit[INTENTION_ORIGIN_PROPERTY]).toBeUndefined();
  });

  it('writes the origin for an intention the substrate filed for itself', () => {
    const properties = intentionProperties({
      label: 'Goal',
      occurredAt: OCCURRED_AT,
      originKind: 'substrate',
    });

    expect(properties[INTENTION_ORIGIN_PROPERTY]).toBe('substrate');
  });

  it('writes no horizon when no horizon days were given', () => {
    const properties = intentionProperties({ label: 'Goal', occurredAt: OCCURRED_AT });

    expect(properties[VALID_HORIZON_PROPERTY]).toBeUndefined();
  });
});

describe('buildStaleIntentionsStatement', () => {
  it('reads the two intention labels and nothing else', () => {
    const { cypher } = buildStaleIntentionsStatement(STALE_BEFORE, 25);
    expect(cypher).toContain('MATCH (n:Goal|Plan)');
  });

  it('takes only intentions still open on both timelines', () => {
    const { cypher } = buildStaleIntentionsStatement(STALE_BEFORE, 25);
    expect(cypher).toContain(`n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
    expect(cypher).toContain(`n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`);
  });

  it('takes only an intention whose horizon passed by the stale mark, not one merely expired', () => {
    const { cypher, parameters } = buildStaleIntentionsStatement(STALE_BEFORE, 25);
    expect(cypher).toContain(`n.${VALID_HORIZON_PROPERTY} IS NOT NULL`);
    expect(cypher).toContain(`n.${VALID_HORIZON_PROPERTY} <= $staleBefore`);
    expect(parameters.staleBefore).toBeDefined();
  });

  it('bounds the scan and reads the oldest horizon first', () => {
    const { cypher } = buildStaleIntentionsStatement(STALE_BEFORE, 25);
    expect(cypher).toContain(`ORDER BY n.${VALID_HORIZON_PROPERTY}, n.id`);
    expect(cypher).toContain('LIMIT $limit');
  });

  it('refuses a batch size that is not a positive integer', () => {
    expect(() => buildStaleIntentionsStatement(STALE_BEFORE, 0)).toThrow(GraphWriteError);
    expect(() => buildStaleIntentionsStatement(STALE_BEFORE, 2.5)).toThrow(GraphWriteError);
  });
});

describe('buildCloseStaleIntentionsStatement', () => {
  it('re-derives staleness at write time, so an intention restated since the scan stands', () => {
    const { cypher } = buildCloseStaleIntentionsStatement(['goal-1'], NOW, STALE_BEFORE);
    expect(cypher).toContain(`n.${VALID_HORIZON_PROPERTY} <= $staleBefore`);
    expect(cypher).toContain(`n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
  });

  it('closes both timelines and names the operation that closed them', () => {
    const { cypher, parameters } = buildCloseStaleIntentionsStatement(
      ['goal-1'],
      NOW,
      STALE_BEFORE,
    );
    expect(cypher).toContain(`n.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(`);
    expect(cypher).toContain(`n.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(`);
    expect(cypher).toContain(`n.${CLOSURE_PROVENANCE_PROPERTY} = coalesce(`);
    expect(parameters.closedBy).toBe(CLOSED_BY_INTENTION_UPKEEP);
  });

  it('never forgets the node, so aion unsupersede is enough to bring the intention back', () => {
    const { cypher } = buildCloseStaleIntentionsStatement(['goal-1'], NOW, STALE_BEFORE);
    expect(cypher).not.toContain(`n.${BITEMPORAL_PROPERTIES.forgottenAt} =`);
  });

  it('refuses an empty batch rather than writing a statement that matches everything', () => {
    expect(() => buildCloseStaleIntentionsStatement([], NOW, STALE_BEFORE)).toThrow(
      GraphWriteError,
    );
  });
});

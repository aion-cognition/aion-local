import { expect, it } from 'vitest';

import { classifyLegacyRelations } from './legacy-materialization.js';
import type { LegacyRelation } from '../../infrastructure/graph/legacy-evidence-queries.js';

const SOURCE = 'episode-1';
const TURN = 'turn-1';

function relation(overrides: Partial<LegacyRelation> = {}): LegacyRelation {
  return {
    relationId: 'rel-1',
    type: 'MENTIONS',
    fromId: SOURCE,
    toId: 'entity-1',
    fromLabels: ['AionNode', 'Episode'],
    toLabels: ['AionNode', 'Entity'],
    ...overrides,
  };
}

it('does not classify an unknown relationship between owned raw nodes as raw ordering', () => {
  const plan = classifyLegacyRelations({
    sourceId: SOURCE,
    rawIds: [SOURCE, TURN],
    relations: [
      relation({
        type: 'UNCLASSIFIED',
        fromId: TURN,
        toId: SOURCE,
        fromLabels: ['Turn'],
        toLabels: ['Episode'],
      }),
    ],
  });
  expect(plan.pins).not.toEqual([]);
});
it('does not erase a second relationship identity that has the same logical endpoints', () => {
  const plan = classifyLegacyRelations({
    sourceId: SOURCE,
    rawIds: [SOURCE, TURN],
    relations: [
      relation({ relationId: 'r1', fromId: SOURCE }),
      relation({ relationId: 'r2', fromId: TURN, fromLabels: ['Turn'] }),
    ],
  });
  expect(
    plan.pins.length > 0 || new Set(plan.links.map((link) => link.relationId)).size === 2,
  ).toBe(true);
});
it('keeps a valid correction to another logical source representable', () => {
  const plan = classifyLegacyRelations({
    sourceId: SOURCE,
    rawIds: [SOURCE, TURN],
    relations: [
      relation({ type: 'CORRECTS', toId: 'another-source', toLabels: ['AionNode', 'Episode'] }),
    ],
  });
  expect(plan.pins).toEqual([]);
  expect(plan.links[0]).toMatchObject({ kind: 'corrects', toId: 'another-source' });
});

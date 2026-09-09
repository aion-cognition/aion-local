import { describe, expect, it } from 'vitest';

import { classifyLegacyRelations, planNodes, planScopes } from './legacy-materialization.js';
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

describe('classifying a legacy source’s incident relationships', () => {
  it('records a mention as an incidence link the source stands behind', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE, TURN],
      relations: [relation()],
    });

    expect(plan.pins).toEqual([]);
    expect(plan.links).toHaveLength(1);
    expect(plan.links[0]).toMatchObject({
      kind: 'mention',
      fromId: SOURCE,
      toId: 'entity-1',
      incident: true,
      scopeRole: 'mention',
      relationId: 'rel-1',
    });
  });

  it('reads an extraction from the end the source sits on', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [
        relation({
          type: 'EXTRACTED_FROM',
          fromId: 'claim-1',
          toId: SOURCE,
          fromLabels: ['AionNode', 'Insight'],
          toLabels: ['AionNode', 'Episode'],
        }),
      ],
    });

    expect(plan.links[0]).toMatchObject({ kind: 'extraction', fromId: SOURCE, toId: 'claim-1' });
  });

  it('tells session ownership from entity participation on the same relationship type', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [
        relation({
          relationId: 'rel-session',
          type: 'PARTICIPATES_IN',
          fromId: SOURCE,
          toId: 'session-1',
          toLabels: ['AionNode', 'Session'],
        }),
        relation({
          relationId: 'rel-entity',
          type: 'PARTICIPATES_IN',
          fromId: 'entity-1',
          toId: SOURCE,
          fromLabels: ['AionNode', 'Entity'],
          toLabels: ['AionNode', 'Episode'],
        }),
      ],
    });

    expect(plan.pins).toEqual([]);
    expect(plan.links.map((entry) => entry.kind).sort()).toEqual([
      'participation',
      'session_ownership',
    ]);
  });

  it('keeps a stated correction as a relation and never as incidence', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [
        relation({
          type: 'CORRECTS',
          toId: 'claim-9',
          toLabels: ['AionNode', 'Insight'],
        }),
      ],
    });

    expect(plan.links[0]).toMatchObject({
      kind: 'corrects',
      scopeRole: 'stated_correction',
      incident: false,
    });
  });

  it('records the source’s own turn order once, whichever end the walk reached', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE, TURN],
      relations: [
        relation({
          relationId: 'rel-contain',
          type: 'PARTICIPATES_IN',
          fromId: TURN,
          toId: SOURCE,
          fromLabels: ['AionNode', 'Turn'],
          toLabels: ['AionNode', 'Episode'],
        }),
      ],
    });

    expect(plan.pins).toEqual([]);
    expect(plan.links[0]).toMatchObject({ kind: 'raw_order', toId: TURN, qualifier: 'part' });
  });

  it('pins a FOLLOWS that crosses into another source rather than adopting its turn', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE, TURN],
      relations: [
        relation({
          relationId: 'rel-follows',
          type: 'FOLLOWS',
          fromId: TURN,
          toId: 'turn-of-another-episode',
          fromLabels: ['AionNode', 'Turn'],
          toLabels: ['AionNode', 'Turn'],
        }),
      ],
    });

    expect(plan.links).toEqual([]);
    expect(plan.pins).toHaveLength(1);
    expect(plan.pins[0]?.relationType).toBe('FOLLOWS');
  });

  it('pins a classified type whose other end is not what the rule requires', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [
        relation({
          type: 'SUMMARIZED_BY',
          toId: 'entity-1',
          toLabels: ['AionNode', 'Entity'],
        }),
      ],
    });

    expect(plan.links).toEqual([]);
    expect(plan.pins[0]?.reason).toContain('SUMMARIZED_BY');
  });

  it('pins a relationship type the vocabulary does not name', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [relation({ type: 'SIMILAR', toId: 'other-1' })],
    });

    expect(plan.links).toEqual([]);
    expect(plan.pins[0]?.relationType).toBe('SIMILAR');
  });

  it('carries the recorded clocks and reads either closing bound as retired', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [
        relation({ relationId: 'open', toId: 'entity-open' }),
        relation({
          relationId: 'world-closed',
          toId: 'entity-a',
          validFrom: '2026-01-01T00:00:00.000Z',
          validUntil: '2026-02-01T00:00:00.000Z',
        }),
        relation({
          relationId: 'tx-closed',
          toId: 'entity-b',
          txUntil: '2026-03-01T00:00:00.000Z',
        }),
      ],
    });

    const byNode = new Map(plan.links.map((entry) => [entry.toId, entry]));
    expect(byNode.get('entity-open')?.closed).toBe(false);
    expect(byNode.get('entity-a')?.closed).toBe(true);
    expect(byNode.get('entity-a')?.clocks).toEqual({
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_until: '2026-02-01T00:00:00.000Z',
    });
    expect(byNode.get('entity-b')?.closed).toBe(true);
  });

  it('moves both ends of every role it records, and never a role it did not', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [relation()],
    });

    expect(planScopes(SOURCE, plan.links)).toEqual([
      { endpointId: 'entity-1', relationClass: 'sqlite:mention:in' },
      { endpointId: SOURCE, relationClass: 'sqlite:mention:out' },
    ]);
    expect(planNodes(plan.links)).toEqual(['entity-1']);
  });

  it('leaves a stated relation out of the nodes ownership is projected for', () => {
    const plan = classifyLegacyRelations({
      sourceId: SOURCE,
      rawIds: [SOURCE],
      relations: [relation({ type: 'CORRECTS', toId: 'claim-9' })],
    });

    expect(planNodes(plan.links)).toEqual([]);
    expect(planScopes(SOURCE, plan.links).map((scope) => scope.relationClass)).toEqual([
      'sqlite:stated_correction:in',
      'sqlite:stated_correction:out',
    ]);
  });
});

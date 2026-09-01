import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY } from './bitemporal.js';
import {
  buildEntityMerge,
  prepareEntityMerge,
  reconcileMergedEntities,
  type EntityMergeInput,
  type EntityMergeRow,
} from './entity-queries.js';

function clause(cypher: string, keyword: string): string {
  const line = cypher.split('\n').find((entry) => entry.startsWith(keyword));
  if (line === undefined) {
    throw new Error(`no ${keyword} clause in\n${cypher}`);
  }
  return line;
}

const ENTITY: EntityMergeInput = {
  name: 'PostgreSQL',
  nameNorm: 'postgresql',
  type: 'tool',
  text: 'PostgreSQL',
  sourceEpisodeId: 'ep-1',
  extractionMethod: 'test',
  confidence: 0.8,
  occurredAt: new Date('2026-08-30T00:00:00.000Z'),
};

const NOW = new Date('2026-08-31T00:00:00.000Z');

function row(overrides: Partial<EntityMergeRow> = {}): EntityMergeRow {
  return {
    proposedId: 'proposed-1',
    nameNorm: 'postgresql',
    id: 'node-1',
    created: false,
    canonicalNameNorm: 'postgresql',
    type: 'tool',
    typeCounts: '{"tool":1}',
    aliases: [],
    isStructural: false,
    hasNameVector: false,
    hasContentVector: false,
    ...overrides,
  };
}

describe('buildEntityMerge identity key', () => {
  it('keys the MERGE on the name alone, so one referent cannot fork on a type', () => {
    const { cypher } = buildEntityMerge([ENTITY], NOW);

    expect(clause(cypher, 'MERGE')).toBe('MERGE (n:Entity { name_norm: entity.name_norm })');
    expect(cypher).not.toContain('type: entity.type');
  });

  it('writes the second lookup key and both alias lists on create', () => {
    const withAliases: EntityMergeInput = {
      ...ENTITY,
      types: ['tool', 'topic'],
      aliases: ['postgres', 'PostgreSQL'],
    };
    const { parameters } = buildEntityMerge([withAliases], NOW);
    const [entity] = parameters.entities as { properties: Record<string, unknown> }[];

    expect(entity?.properties.name_squash).toBe('postgresql');
    expect(entity?.properties.type_counts).toBe('{"tool":1,"topic":1}');
    // The identity's own name is not an alias of itself, whatever case the model spelled it in.
    expect(entity?.properties.aliases).toEqual(['postgres']);
    expect(entity?.properties.aliases_norm).toEqual(['postgres']);
  });

  it('takes the resolved node under lock, because the chain walk lands where the MERGE did not write', () => {
    const { cypher } = buildEntityMerge([ENTITY], NOW);
    expect(cypher).toContain('SET resolved.locked_at = $now');
  });
});

describe('buildEntityMerge reopening a maintenance-closed node', () => {
  it('reopens the full closed timeline and clears the marker when the match carries it', () => {
    const onMatch = clause(buildEntityMerge([ENTITY], NOW).cypher, 'ON MATCH SET');
    const reopenCondition = `n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL AND n.${CLOSURE_PROVENANCE_PROPERTY} IS NOT NULL`;

    expect(onMatch).toContain(
      `n.${BITEMPORAL_PROPERTIES.validUntil} = CASE WHEN ${reopenCondition} THEN null`,
    );
    expect(onMatch).toContain(
      `n.${BITEMPORAL_PROPERTIES.txUntil} = CASE WHEN ${reopenCondition} THEN null`,
    );
    expect(onMatch).toContain(
      `n.${BITEMPORAL_PROPERTIES.forgottenAt} = CASE WHEN ${reopenCondition} THEN null`,
    );
    expect(onMatch).toContain(
      `n.${CLOSURE_PROVENANCE_PROPERTY} = CASE WHEN ${reopenCondition} THEN null`,
    );
  });

  it('leaves a node closed without the marker on exactly its prior value', () => {
    // The ELSE arm is what a node closed by `aion forget` or a supersession absorb actually
    // evaluates: self-assignment to the property's own current value, the same as never touching
    // it, which is what this branch did before the reopen existed at all.
    const onMatch = clause(buildEntityMerge([ENTITY], NOW).cypher, 'ON MATCH SET');

    expect(onMatch).toContain(`ELSE n.${BITEMPORAL_PROPERTIES.validUntil} END`);
    expect(onMatch).toContain(`ELSE n.${BITEMPORAL_PROPERTIES.txUntil} END`);
    expect(onMatch).toContain(`ELSE n.${BITEMPORAL_PROPERTIES.forgottenAt} END`);
    expect(onMatch).toContain(`ELSE n.${CLOSURE_PROVENANCE_PROPERTY} END`);
  });

  // The reopen condition is evaluated by Neo4j against the matched row, not by this builder: an
  // open node (valid_until IS NULL) fails the same condition an unmarked closed node fails, and
  // lands on the identical ELSE arm the test above pins. One Cypher string covers both runtime
  // cases; identifier-decay.int.test.ts is what exercises the split end to end.

  it('still applies companion labels on every match, unchanged from before the reopen', () => {
    const onMatch = clause(buildEntityMerge([ENTITY], NOW).cypher, 'ON MATCH SET');
    expect(onMatch.startsWith('ON MATCH SET n:')).toBe(true);
  });
});

describe('reconcileMergedEntities', () => {
  it('counts this run against what the node already carries and follows the readings', () => {
    const input: EntityMergeInput = { ...ENTITY, types: ['topic'] };
    const { updates, merged } = reconcileMergedEntities(
      [input],
      ['proposed-1'],
      [row({ typeCounts: '{"tool":1,"topic":1}' })],
    );

    expect(updates).toEqual([
      {
        id: 'node-1',
        type: 'topic',
        typeCounts: '{"tool":1,"topic":2}',
        nameSquash: 'postgresql',
        aliases: [],
        aliasesNorm: [],
      },
    ]);
    expect(merged[0]?.type).toBe('topic');
  });

  it('keeps the incumbent on a tie, so equal evidence never flips a label', () => {
    const input: EntityMergeInput = { ...ENTITY, types: ['topic'] };
    const { updates } = reconcileMergedEntities(
      [input],
      ['proposed-1'],
      [row({ typeCounts: '{"tool":2,"topic":1}' })],
    );

    expect(updates[0]?.type).toBe('tool');
  });

  it('never counts a creation twice: ON CREATE already recorded its reading', () => {
    const input: EntityMergeInput = { ...ENTITY, types: ['tool'], aliases: ['postgres'] };
    const { updates } = reconcileMergedEntities(
      [input],
      ['proposed-1'],
      [row({ created: true, id: 'proposed-1', typeCounts: '{"tool":1}', aliases: ['postgres'] })],
    );

    expect(updates[0]?.typeCounts).toBe('{"tool":1}');
    expect(updates[0]?.aliases).toEqual(['postgres']);
  });

  it('folds several inputs onto one identity, so the last row cannot drop the others', () => {
    const first: EntityMergeInput = { ...ENTITY, types: ['topic'], aliases: ['pg'] };
    const second: EntityMergeInput = { ...ENTITY, types: ['topic'], aliases: ['pgsql'] };
    const { updates } = reconcileMergedEntities(
      [first, second],
      ['proposed-1', 'proposed-2'],
      [row(), row({ proposedId: 'proposed-2' })],
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]?.aliasesNorm).toEqual(['pg', 'pgsql']);
    // Two spellings alias routing sent to one node are one extraction reading it once, so the
    // count moves by one; the aliases both spellings carried are what accumulates.
    expect(updates[0]?.typeCounts).toBe('{"tool":1,"topic":1}');
  });

  it('writes nothing back to the backbone, which keeps its own type and identity', () => {
    const { updates, merged } = reconcileMergedEntities(
      [ENTITY],
      ['proposed-1'],
      [row({ isStructural: true, type: 'member', typeCounts: '' })],
    );

    expect(updates).toEqual([]);
    expect(merged[0]?.type).toBe('member');
  });

  it('pairs a row back to its own input by the id this run proposed', () => {
    const prepared = prepareEntityMerge([ENTITY], NOW);
    const [proposedId] = prepared.proposedIds;
    const { merged } = reconcileMergedEntities([ENTITY], prepared.proposedIds, [
      row({ proposedId: proposedId ?? '' }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.nameNorm).toBe('postgresql');
  });
});

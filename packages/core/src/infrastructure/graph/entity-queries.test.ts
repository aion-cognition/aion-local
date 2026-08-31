import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY } from './bitemporal.js';
import { buildEntityMerge, type EntityMergeInput } from './entity-queries.js';

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
};

const NOW = new Date('2026-08-31T00:00:00.000Z');

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

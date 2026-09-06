import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import {
  buildNarrativeEdgeClose,
  buildNarrativeEdgeCounts,
  buildStaleNarrativeEdgeClose,
} from './narrative-edge-queries.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const VALID_UNTIL = new Date('2026-09-06T09:00:00.000Z');

describe('buildNarrativeEdgeClose', () => {
  const statement = buildNarrativeEdgeClose({
    narrativeIds: ['n-1', 'n-2', 'n-1'],
    validUntil: VALID_UNTIL,
    txUntil: NOW,
  });

  it('closes only the edges that summarize the named narratives', () => {
    expect(statement.cypher).toContain(`-[r:${SUMMARIZED_BY_TYPE}]->`);
    expect(statement.parameters.narrativeIds).toEqual(['n-1', 'n-2']);
  });

  it('skips an edge a previous attempt already closed, so a retry converges', () => {
    expect(statement.cypher).toContain(`r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
    expect(statement.cypher).toContain(
      `r.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(r.${BITEMPORAL_PROPERTIES.validUntil}, $validUntil)`,
    );
    expect(statement.cypher).toContain(
      `r.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(r.${BITEMPORAL_PROPERTIES.txUntil}, $txUntil)`,
    );
  });

  it('leaves the lineage and provenance types alone', () => {
    expect(statement.cypher).not.toContain('DERIVES_FROM');
    expect(statement.cypher).not.toContain('SUPERSEDES');
  });

  it('never deletes', () => {
    expect(statement.cypher).not.toContain('DELETE');
  });
});

describe('buildStaleNarrativeEdgeClose', () => {
  const statement = buildStaleNarrativeEdgeClose({ batchSize: 250, now: NOW });

  it('selects open edges pointing at a narrative something already closed', () => {
    expect(statement.cypher).toContain(`r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
    expect(statement.cypher).toContain(`n.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`);
  });

  it('bounds one run to the batch it was given', () => {
    expect(statement.cypher).toContain('LIMIT $batchSize');
    expect(Number(statement.parameters.batchSize)).toBe(250);
  });

  it('ends the edge at the world time its narrative stopped standing', () => {
    expect(statement.cypher).toContain(
      `coalesce(r.${BITEMPORAL_PROPERTIES.validUntil}, n.${BITEMPORAL_PROPERTIES.validUntil}, $validUntil)`,
    );
  });

  it('rejects a batch that would close everything or nothing', () => {
    expect(() => buildStaleNarrativeEdgeClose({ batchSize: 0, now: NOW })).toThrow();
  });
});

describe('buildNarrativeEdgeCounts', () => {
  it('splits open summarization edges by whether their narrative still stands', () => {
    const { cypher } = buildNarrativeEdgeCounts();

    expect(cypher).toContain('AS active');
    expect(cypher).toContain('AS stale');
    expect(cypher).toContain(`r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`);
  });
});

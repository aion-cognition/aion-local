import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { GraphWriteError } from './errors.js';
import { buildCandidatesStatement, buildCloseStatement } from './identifier-decay-queries.js';

describe('buildCandidatesStatement', () => {
  it('scans only current, unforgotten entities', () => {
    const { cypher } = buildCandidatesStatement(500);
    expect(cypher).toContain('MATCH (n:Entity)');
    expect(cypher).toContain('n.valid_until IS NULL AND n.forgotten_at IS NULL');
  });

  it('aggregates distinct mentioning episodes and the latest mention stamp', () => {
    const { cypher } = buildCandidatesStatement(500);
    expect(cypher).toContain('count(DISTINCT e) AS episode_mentions');
    expect(cypher).toContain('max(m.updated_at) AS last_mention_at');
  });

  it('flags a merge-lineage canonical target by its own outgoing SUPERSEDES edge', () => {
    const { cypher } = buildCandidatesStatement(500);
    expect(cypher).toContain('EXISTS { (n)-[:SUPERSEDES]->(:Entity) } AS is_canonical_target');
  });

  it('flags a typed-knowledge edge from the named allowlist, not the association types', () => {
    const { cypher, parameters } = buildCandidatesStatement(500);
    expect(cypher).toContain('EXISTS { MATCH (n)-[r]-() WHERE type(r) IN $typedKnowledgeTypes }');
    expect(parameters.typedKnowledgeTypes).toEqual([
      'CAUSES',
      'ENABLES',
      'PRECEDES',
      'DERIVES_FROM',
    ]);
  });

  it('bounds the batch as a Neo4j integer, matching LIMIT', () => {
    const { cypher, parameters } = buildCandidatesStatement(500);
    expect(cypher).toContain('LIMIT $batchSize');
    expect(parameters.batchSize).toEqual(neo4j.int(500));
  });

  it('rejects a batch size that is not a positive integer', () => {
    expect(() => buildCandidatesStatement(0)).toThrow(GraphWriteError);
    expect(() => buildCandidatesStatement(1.5)).toThrow(GraphWriteError);
  });
});

describe('buildCloseStatement', () => {
  const NOW = new Date('2026-08-31T00:00:00.000Z');

  it('stamps closed_by with this operation, so a later mention knows the close is undoable', () => {
    const { cypher, parameters } = buildCloseStatement(['e1'], NOW);
    expect(cypher).toContain('n.closed_by = coalesce(n.closed_by, $closedBy)');
    expect(parameters.closedBy).toBe('identifier_decay');
  });

  it('closes the entity to the full extent of its own timeline: forgotten_at, valid_until, tx_until', () => {
    const { cypher } = buildCloseStatement(['e1'], NOW);
    expect(cypher).toContain('n.forgotten_at = coalesce(n.forgotten_at, $now)');
    expect(cypher).toContain('n.valid_until = coalesce(n.valid_until, $now)');
    expect(cypher).toContain('n.tx_until = coalesce(n.tx_until, $now)');
    expect(cypher).not.toMatch(/DETACH\s+DELETE/i);
  });

  it('closes current MENTIONS and CO_OCCURS edges touching the entity, undirected for CO_OCCURS', () => {
    const { cypher } = buildCloseStatement(['e1'], NOW);
    expect(cypher).toContain('(:Episode)-[m:MENTIONS]->(n)');
    expect(cypher).toContain('m.valid_until IS NULL');
    expect(cypher).toContain('(n)-[c:CO_OCCURS]-(:Entity)');
    expect(cypher).toContain('c.valid_until IS NULL');
  });

  it('only matches an entity still current and unforgotten, so a second call over the same ids is a no-op', () => {
    const { cypher } = buildCloseStatement(['e1'], NOW);
    expect(cypher).toContain('n.valid_until IS NULL AND n.forgotten_at IS NULL');
  });

  it('rejects an empty id list rather than issuing a no-op write', () => {
    expect(() => buildCloseStatement([], NOW)).toThrow(GraphWriteError);
  });
});

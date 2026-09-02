import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY } from '../bitemporal.js';
import { readFirst, runRead } from '../connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL } from '../labels.js';
import { NARRATIVE_PROPERTIES } from '../narrative-queries.js';
import type { RelationshipType } from '../relationships.js';

/** One typed edge's prune-relevant properties, for asserting `edge_prune` closed exactly what it should. */
export type EdgePruneState = {
  readonly strength: number | undefined;
  readonly validUntil: Date | undefined;
  readonly updatedAt: Date | undefined;
};

/**
 * Assertion reads for the maintenance operations, kept beside the other graph test-support
 * queries so every Cypher statement that runs lives under `infrastructure/graph/`. Separate
 * from `graph-queries.fixture.ts` only because the two together pass the line cap.
 */

/** The sessions one episode reaches through the containment edge: what a backbone repair restores. */
export async function sessionIdsOfEpisode(driver: Driver, episodeId: string): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (e:Episode { id: $id })-[:${CONTAINMENT_TYPE}]->(s:Session) RETURN s.id AS id`,
    { id: episodeId },
    (row) => row.id as string,
  );
}

/** The signals on those edges, so a repaired link is separable from the one intake wrote. */
export async function sessionLinkSignals(driver: Driver, episodeId: string): Promise<string[]> {
  const rows = await runRead(
    driver,
    `MATCH (e:Episode { id: $id })-[r:${CONTAINMENT_TYPE}]->(:Session) RETURN r.signals AS signals`,
    { id: episodeId },
    (row) => (row.signals as string[] | null) ?? [],
  );
  return rows.flat();
}

/** The grounding revision one narrative was written under; absent when it carries none. */
export async function narrativeGrounding(driver: Driver, id: string): Promise<string | undefined> {
  const value = await readFirst(
    driver,
    `MATCH (n:Narrative { id: $id }) RETURN n.${NARRATIVE_PROPERTIES.grounding} AS grounding`,
    { id },
    (row) => row.grounding,
  );
  return typeof value === 'string' ? value : undefined;
}

/** Standing bridges, newest first, with the sentence each one carries. */
export async function standingBridges(driver: Driver): Promise<{ id: string; text: string }[]> {
  return runRead(
    driver,
    [
      'MATCH (b:Bridge)',
      `WHERE b.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      `RETURN b.id AS id, coalesce(b.${MEMORY_PROPERTIES.text}, '') AS text`,
      `ORDER BY b.${BITEMPORAL_PROPERTIES.txFrom} DESC, b.id`,
    ].join('\n'),
    {},
    (row) => ({ id: row.id as string, text: row.text as string }),
  );
}

/** What a standing bridge is attached to, and the reason each attachment gives for existing. */
export async function bridgeEndpoints(
  driver: Driver,
): Promise<{ id: string; provenance: string[]; rationale: string }[]> {
  return runRead(
    driver,
    [
      'MATCH (b:Bridge)-[r:RELATED_TO]-(n:AionNode)',
      `WHERE b.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      'RETURN n.id AS id, coalesce(r.provenance, []) AS provenance,',
      "       coalesce(r.rationale, '') AS rationale",
    ].join('\n'),
    {},
    (row) => ({
      id: row.id as string,
      provenance: (row.provenance as string[] | null) ?? [],
      rationale: row.rationale as string,
    }),
  );
}

/** Every relationship type on any edge between two nodes, undirected: what orphan relink leaves behind. */
export async function relationshipTypesBetween(
  driver: Driver,
  left: string,
  right: string,
): Promise<string[]> {
  return runRead(
    driver,
    `MATCH (a:${BASE_NODE_LABEL} { id: $left })-[r]-(b:${BASE_NODE_LABEL} { id: $right }) RETURN type(r) AS type`,
    { left, right },
    (row) => row.type as string,
  );
}

/** `undefined` for every field when the named typed edge does not exist between the two nodes. */
export async function edgePruneState(
  driver: Driver,
  sourceId: string,
  targetId: string,
  type: RelationshipType,
): Promise<EdgePruneState> {
  const row = await readFirst(
    driver,
    [
      `MATCH (a:${BASE_NODE_LABEL} { id: $sourceId })-[r:${type}]->(b:${BASE_NODE_LABEL} { id: $targetId })`,
      `RETURN r.strength AS strength, r.${BITEMPORAL_PROPERTIES.validUntil} AS valid_until,`,
      '       r.updated_at AS updated_at',
    ].join('\n'),
    { sourceId, targetId },
    (record) => ({
      strength: typeof record.strength === 'number' ? record.strength : undefined,
      validUntil: record.valid_until instanceof Date ? record.valid_until : undefined,
      updatedAt: record.updated_at instanceof Date ? record.updated_at : undefined,
    }),
  );
  return row ?? { strength: undefined, validUntil: undefined, updatedAt: undefined };
}

/** An entity's own bitemporal stamps, for asserting `identifier_decay` closed it to the full
 * extent of its timeline (both stamps) rather than only forgetting it, and whether a maintenance
 * close still marks it (`closedBy`) or a mention has since reopened it. */
export type IdentifierEntityState = {
  readonly forgottenAt: Date | undefined;
  readonly validUntil: Date | undefined;
  readonly closedBy: string | undefined;
};

export async function identifierEntityState(
  driver: Driver,
  id: string,
): Promise<IdentifierEntityState> {
  const row = await readFirst(
    driver,
    [
      `MATCH (n:${ENTITY_LABEL} { id: $id })`,
      `RETURN n.${BITEMPORAL_PROPERTIES.forgottenAt} AS forgotten_at,`,
      `       n.${BITEMPORAL_PROPERTIES.validUntil} AS valid_until,`,
      `       n.${CLOSURE_PROVENANCE_PROPERTY} AS closed_by`,
    ].join('\n'),
    { id },
    (row2) => ({
      forgottenAt: row2.forgotten_at instanceof Date ? row2.forgotten_at : undefined,
      validUntil: row2.valid_until instanceof Date ? row2.valid_until : undefined,
      closedBy: typeof row2.closed_by === 'string' ? row2.closed_by : undefined,
    }),
  );
  return row ?? { forgottenAt: undefined, validUntil: undefined, closedBy: undefined };
}

/** Current episode ids, oldest first, for a test that has to clear the field before it seeds. */
export async function currentEpisodeIds(driver: Driver): Promise<string[]> {
  return runRead(
    driver,
    [
      'MATCH (e:Episode)',
      `WHERE e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
      `RETURN e.id AS id ORDER BY e.${BITEMPORAL_PROPERTIES.txFrom}, e.id`,
    ].join('\n'),
    {},
    (row) => row.id as string,
  );
}

/** What a discovery write stamps on an association edge, read from whichever end it points. */
export type AssociationEdgeState = {
  readonly strength: number | undefined;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly rationale: string | undefined;
};

/** `undefined` when no edge of that type stands between the two nodes, either direction. */
export async function associationEdgeState(
  driver: Driver,
  leftId: string,
  rightId: string,
  type: RelationshipType,
): Promise<AssociationEdgeState | undefined> {
  return readFirst(
    driver,
    [
      `MATCH (a:${BASE_NODE_LABEL} { id: $leftId })-[r:${type}]-(b:${BASE_NODE_LABEL} { id: $rightId })`,
      `WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
      'RETURN r.strength AS strength, r.signals AS signals, r.provenance AS provenance,',
      '       r.rationale AS rationale',
    ].join('\n'),
    { leftId, rightId },
    (row) => ({
      strength: typeof row.strength === 'number' ? row.strength : undefined,
      signals: (row.signals as string[] | null) ?? [],
      provenance: (row.provenance as string[] | null) ?? [],
      rationale: typeof row.rationale === 'string' ? row.rationale : undefined,
    }),
  );
}

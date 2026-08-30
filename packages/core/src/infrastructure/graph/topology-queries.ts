import neo4j, { type Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import type { Row } from './values.js';

/**
 * The graph side of orphan cleanup. An orphan here is what the health snapshot already
 * counts: a current content-bearing node whose every relationship is a backbone or
 * provenance type. Such a node hangs off the structure and off nothing it was ever
 * associated with, so spreading activation reaches it only by walking the wiring, which is
 * the fragmentation the count exists to report.
 *
 * Nothing in this module writes. Relinking goes through the ordinary edge upsert and
 * forgetting goes through `forgetNode`, so an orphan repair leaves the same trail any other
 * write leaves.
 */

const BACKBONE_TYPES = PROTECTED_RELATIONSHIP_TYPES.map((type) => `'${type}'`).join(', ');

/** Reflection's provenance edge, which is what makes an episode enriched rather than pending. */
const EXTRACTION_TYPE = 'EXTRACTED_FROM';

const CURRENT = (variable: string): string =>
  [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `${variable}.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  ].join(' AND ');

/** `LIMIT` is Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export type OrphanNode = {
  readonly id: string;
  /** When the substrate learned the node, which is what the forget threshold measures against. */
  readonly txFrom?: Date;
};

/**
 * Oldest first. A node the reflection worker has not reached yet is an orphan by this
 * definition and is also the newest thing in the graph, so taking the oldest slice spends the
 * batch on fragmentation that has had time to be real.
 *
 * Structural nodes are excluded outright. The Member and the global Workspace are
 * connectivity rather than content, and they carry no `Memory` label, but an entity a
 * bootstrap marked structural does; neither is ever a repair subject.
 */
const FIND_ORPHAN_NODES = [
  'MATCH (n:Memory)',
  `WHERE ${CURRENT('n')}`,
  `  AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  // Same exclusion the health count applies: an episode reflection has not processed is
  // pending, not fragmented, and a heuristic relink onto it hides the backlog it belongs to.
  `  AND NOT (n:Episode AND NOT EXISTS { MATCH ()-[:${EXTRACTION_TYPE}]->(n) })`,
  `  AND NOT EXISTS { MATCH (n)-[r]-() WHERE NOT type(r) IN [${BACKBONE_TYPES}] }`,
  `RETURN n.id AS id, n.${BITEMPORAL_PROPERTIES.txFrom} AS tx_from`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.txFrom}, n.id`,
  'LIMIT $limit',
].join('\n');

function mapOrphanNode(row: Row): OrphanNode {
  const txFrom = row.tx_from;
  return {
    id: row.id as string,
    ...(txFrom instanceof Date ? { txFrom } : {}),
  };
}

export async function findOrphanNodes(driver: Driver, limit: number): Promise<OrphanNode[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(driver, FIND_ORPHAN_NODES, { limit: toGraphInteger(limit) }, mapOrphanNode);
}

/** Which rule found the target, carried onto the repair edge so the relink says why it exists. */
export type RelinkKind = 'shared_entity' | 'same_container';

export type OrphanRelinkTarget = {
  readonly orphanId: string;
  readonly targetId: string;
  readonly kind: RelinkKind;
};

/**
 * The cheap candidate, found in two hops through the wiring the orphan still has.
 *
 * The first rule reaches an entity the orphan's own container mentions. That is the better
 * repair of the two: it plugs the node back into the association layer activation actually
 * traverses, rather than pairing two islands. It fits an extracted node, whose container is
 * the episode it came from.
 *
 * The second rule reaches a sibling under the same container. It is what is left for an
 * episode, whose container is a session and a session mentions nothing.
 *
 * Both stay inside two hops on purpose: a candidate that takes a search to find is not a
 * cheap one, and a repair that guesses is worse than an orphan that waits.
 */
const FIND_ORPHAN_RELINK_TARGETS = [
  'UNWIND $ids AS orphanId',
  `MATCH (o:${BASE_NODE_LABEL} { id: orphanId })`,
  `OPTIONAL MATCH (o)-[b1]-(container:${BASE_NODE_LABEL})-[m:${ENTITY_MENTION_TYPE}]-(shared:Entity)`,
  `  WHERE type(b1) IN [${BACKBONE_TYPES}]`,
  `    AND ${CURRENT('shared')}`,
  '    AND shared.id <> orphanId',
  'WITH orphanId, o, shared, coalesce(m.count, 0) AS weight',
  'ORDER BY weight DESC, shared.id',
  'WITH orphanId, o, collect(shared.id)[0] AS sharedId',
  `OPTIONAL MATCH (o)-[b2]-(parent:${BASE_NODE_LABEL})-[b3]-(sibling:Memory)`,
  `  WHERE type(b2) IN [${BACKBONE_TYPES}] AND type(b3) IN [${BACKBONE_TYPES}]`,
  `    AND ${CURRENT('sibling')}`,
  `    AND coalesce(sibling.${STRUCTURAL_PROPERTY}, false) = false`,
  '    AND sibling.id <> orphanId',
  'WITH orphanId, sharedId, sibling ORDER BY sibling.id',
  'WITH orphanId, sharedId, collect(sibling.id)[0] AS siblingId',
  'WITH orphanId, coalesce(sharedId, siblingId) AS targetId,',
  "     CASE WHEN sharedId IS NULL THEN 'same_container' ELSE 'shared_entity' END AS kind",
  'WHERE targetId IS NOT NULL',
  'RETURN orphanId, targetId, kind',
].join('\n');

export async function findOrphanRelinkTargets(
  driver: Driver,
  ids: readonly string[],
): Promise<OrphanRelinkTarget[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  return runRead(driver, FIND_ORPHAN_RELINK_TARGETS, { ids: unique }, (row) => ({
    orphanId: row.orphanId as string,
    targetId: row.targetId as string,
    kind: row.kind === 'shared_entity' ? 'shared_entity' : 'same_container',
  }));
}

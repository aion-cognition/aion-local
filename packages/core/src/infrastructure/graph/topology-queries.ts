import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, runWrite } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { BACKBONE_TYPES, BASE_NODE_LABEL, EXTRACTION_TYPE, MEMORY_LABEL } from './labels.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';

/**
 * The graph side of orphan cleanup. An orphan here is what the health snapshot already
 * counts: a current content-bearing node whose every relationship is a backbone or
 * provenance type. Such a node hangs off the structure and off nothing it was ever
 * associated with, so spreading activation reaches it only by walking the wiring, which is
 * the fragmentation the count exists to report.
 *
 * Relinking goes through the ordinary edge upsert, so a repair edge leaves the same trail any
 * other edge leaves. The one write here is the forget, which carries the orphan test with it
 * because a suppression decided off a stale reading has no reopen path.
 */

export type OrphanNode = {
  readonly id: string;
  /** When the substrate learned the node, which is what the forget threshold measures against. */
  readonly txFrom?: Date;
};

/**
 * The orphan test itself, shared by the scan and the forget so the two cannot drift apart.
 *
 * Structural nodes are excluded outright. The Member and the global Workspace are
 * connectivity rather than content, and they carry no `Memory` label, but an entity a
 * bootstrap marked structural does; neither is ever a repair subject.
 */
const ORPHAN_PREDICATE = [
  currentOnly('n'),
  `  AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  // Same exclusion the health count applies: an episode reflection has not processed is
  // pending, not fragmented, and a heuristic relink onto it hides the backlog it belongs to.
  `  AND NOT (n:Episode AND NOT EXISTS { MATCH ()-[:${EXTRACTION_TYPE}]->(n) })`,
  `  AND NOT EXISTS { MATCH (n)-[r]-() WHERE NOT type(r) IN [${BACKBONE_TYPES}] }`,
].join('\n');

/**
 * Oldest first. A node the reflection worker has not reached yet is an orphan by this
 * definition and is also the newest thing in the graph, so taking the oldest slice spends the
 * batch on fragmentation that has had time to be real.
 */
const FIND_ORPHAN_NODES = [
  `MATCH (n:${MEMORY_LABEL})`,
  `WHERE ${ORPHAN_PREDICATE}`,
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

/**
 * The forget the orphan sweep writes, carrying the orphan test and the age threshold in the
 * same statement that sets the stamp. The scan that chose the node ran before the batch, and a
 * node that gained an association edge in between is no longer an orphan; forgetting it there
 * is permanent and has no reopen path, so the write re-derives the decision from the graph.
 *
 * The orphan test already requires currency, so a node an earlier forget suppressed matches
 * nothing here and keeps the stamp it has.
 */
const FORGET_ORPHAN_NODE = [
  `MATCH (n:${MEMORY_LABEL} { id: $id })`,
  `WHERE ${ORPHAN_PREDICATE}`,
  `  AND n.${BITEMPORAL_PROPERTIES.txFrom} IS NOT NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.txFrom} <= $forgetBefore`,
  `SET n.${BITEMPORAL_PROPERTIES.forgottenAt} = $now`,
  'RETURN n.id AS id',
].join('\n');

/** True when this call is what suppressed the node; false when it was no longer eligible. */
export async function forgetOrphanNode(
  driver: Driver,
  input: { readonly id: string; readonly forgetBefore: Date; readonly now: Date },
): Promise<boolean> {
  const rows = await runWrite(
    driver,
    FORGET_ORPHAN_NODE,
    {
      id: input.id,
      forgetBefore: toGraphDateTime(input.forgetBefore),
      now: toGraphDateTime(input.now),
    },
    (row) => row.id as string,
  );
  return rows.length > 0;
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
  `    AND ${currentOnly('shared')}`,
  '    AND shared.id <> orphanId',
  'WITH orphanId, o, shared, coalesce(m.count, 0) AS weight',
  'ORDER BY weight DESC, shared.id',
  'WITH orphanId, o, collect(shared.id)[0] AS sharedId',
  `OPTIONAL MATCH (o)-[b2]-(parent:${BASE_NODE_LABEL})-[b3]-(sibling:${MEMORY_LABEL})`,
  `  WHERE type(b2) IN [${BACKBONE_TYPES}] AND type(b3) IN [${BACKBONE_TYPES}]`,
  `    AND ${currentOnly('sibling')}`,
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

import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead, runWrite, type GraphTransaction } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { BACKBONE_TYPES, BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
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
  // Raw containers are never repair subjects. An Episode and a Turn are what a source IS, not an
  // interpretation drawn from one: they hang off the wiring by construction, a relink onto one
  // reconnects nothing anybody reads, and forgetting one suppresses the record the durable
  // evidence points at. The archive and the records are what account for a raw container.
  `  AND NOT n:Episode AND NOT n:Turn`,
  // Only an OPEN association counts as reaching this node. A closed edge is a relationship that
  // was ended, and treating it as connectivity leaves a node permanently out of the population
  // on the strength of a link nothing traverses.
  `  AND NOT EXISTS {
       MATCH (n)-[r]-()
       WHERE NOT type(r) IN [${BACKBONE_TYPES}]
         AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL
         AND r.${BITEMPORAL_PROPERTIES.txUntil} IS NULL
     }`,
].join('\n');

/**
 * Oldest first, and resumable. A node the reflection worker has not reached yet is an orphan by
 * this definition and is also the newest thing in the graph, so taking the oldest slice spends
 * the batch on fragmentation that has had time to be real.
 *
 * The caller's position is a keyset on the same order the query returns, so a later page costs
 * exactly what an earlier one did. Paging by fetching a longer prefix and discarding its head
 * reads the whole backlog to reach its tail, which is the bound this exists to hold.
 *
 * Dates sort before nulls, which is what the last clause is for: once the cursor is on a dated
 * row, the undated ones are still ahead.
 */
const AFTER_POSITION = [
  `($afterId IS NULL`,
  `  OR (n.${BITEMPORAL_PROPERTIES.txFrom} IS NOT NULL AND $afterTxFrom IS NOT NULL`,
  `      AND n.${BITEMPORAL_PROPERTIES.txFrom} > $afterTxFrom)`,
  `  OR (n.${BITEMPORAL_PROPERTIES.txFrom} = $afterTxFrom AND n.id > $afterId)`,
  `  OR (n.${BITEMPORAL_PROPERTIES.txFrom} IS NULL AND $afterTxFrom IS NULL AND n.id > $afterId)`,
  `  OR (n.${BITEMPORAL_PROPERTIES.txFrom} IS NULL AND $afterTxFrom IS NOT NULL))`,
].join('\n');

const FIND_ORPHAN_NODES = [
  `MATCH (n:${MEMORY_LABEL})`,
  `WHERE ${ORPHAN_PREDICATE}`,
  `  AND ${AFTER_POSITION}`,
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

/** Where a page resumes: the last row the previous page returned, in the query's own order. */
export type OrphanPosition = {
  readonly txFrom: Date | undefined;
  readonly id: string;
};

export async function findOrphanNodes(
  driver: Driver,
  limit: number,
  after?: OrphanPosition,
): Promise<OrphanNode[]> {
  if (limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    FIND_ORPHAN_NODES,
    {
      limit: toGraphInteger(limit),
      afterId: after?.id ?? null,
      afterTxFrom: after?.txFrom === undefined ? null : toGraphDateTime(after.txFrom),
    },
    mapOrphanNode,
  );
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

export type OrphanForget = {
  readonly id: string;
  readonly forgetBefore: Date;
  readonly now: Date;
};

function forgetParameters(input: OrphanForget): Record<string, unknown> {
  return {
    id: input.id,
    forgetBefore: toGraphDateTime(input.forgetBefore),
    now: toGraphDateTime(input.now),
  };
}

/** True when this call is what suppressed the node; false when it was no longer eligible. */
export async function forgetOrphanNode(driver: Driver, input: OrphanForget): Promise<boolean> {
  const rows = await runWrite(
    driver,
    FORGET_ORPHAN_NODE,
    forgetParameters(input),
    (row) => row.id as string,
  );
  return rows.length > 0;
}

/**
 * The same suppression inside a caller's transaction, which is where the guarded writer runs it.
 * A publication holds the guard for the whole operation, and a second transaction opened
 * underneath it would commit outside the receipt that is supposed to say whether it landed.
 */
export async function forgetOrphanNodeInTransaction(
  tx: GraphTransaction,
  input: OrphanForget,
): Promise<boolean> {
  const rows = await tx.run(FORGET_ORPHAN_NODE, forgetParameters(input), (row) => row.id as string);
  return rows.length > 0;
}

/**
 * What has happened to a node's associations, whichever of them are open now.
 *
 * The population is defined by the absence of an OPEN association, and a reading of the open
 * ones cannot tell a node nothing ever reached from a node an association reached and left: both
 * read empty. The token carries how many association rows the node has at all and the latest
 * stamp any of them took, so an edge arriving, closing or reopening moves it and a window taken
 * across that interval is void. Backbone types are excluded for the same reason the orphan test
 * excludes them: they are the wiring, not an association.
 *
 * Absent from the answer means the graph does not hold the node, which is not a history: a caller
 * that cannot read this leaves the qualification unknown rather than certifying an interval
 * nobody observed.
 */
const NODE_ASSOCIATION_HISTORY = [
  'UNWIND $ids AS nodeId',
  `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })`,
  'OPTIONAL MATCH (n)-[r]-()',
  `  WHERE NOT type(r) IN [${BACKBONE_TYPES}]`,
  'WITH nodeId, count(r) AS relations,',
  `     max(toString(coalesce(r.${BITEMPORAL_PROPERTIES.txUntil}, r.updated_at, r.created_at)))`,
  '       AS lastChange',
  'RETURN nodeId AS id, relations, lastChange',
].join('\n');

/** One node's association history, by id. A node the graph does not hold has no entry. */
export type AssociationHistory = ReadonlyMap<string, string>;

/**
 * The comparable form of one reading: how many association rows, and the latest stamp any of
 * them carries. One producer, so the census and the guard compare the same shape.
 */
export function associationHistoryToken(relations: unknown, lastChange: unknown): string {
  return `${String(relations)}@${typeof lastChange === 'string' ? lastChange : 'none'}`;
}

/** What a node no association has ever touched reads as. */
export const NO_ASSOCIATION_HISTORY = associationHistoryToken(0, undefined);

function mapHistoryRow(row: Row): readonly [string, string] {
  return [row.id as string, associationHistoryToken(row.relations, row.lastChange)];
}

export async function nodeAssociationHistory(
  driver: Driver,
  ids: readonly string[],
): Promise<AssociationHistory> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  return new Map(await runRead(driver, NODE_ASSOCIATION_HISTORY, { ids: unique }, mapHistoryRow));
}

/** The same reading inside the guard's transaction, where a repair re-derives what it acts on. */
export async function nodeAssociationHistoryInTransaction(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<AssociationHistory> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  return new Map(await tx.run(NODE_ASSOCIATION_HISTORY, { ids: unique }, mapHistoryRow));
}

/**
 * Which of these ids the graph currently holds as eligible retained nodes.
 *
 * Content-bearing, current and not structural: the eligibility the population is defined by,
 * asked about named nodes instead of about the whole graph. A repair edge is a present-tense
 * claim, so the endpoints it names have to be present tense too. A node forgotten or closed
 * since the nomination is not one of them, and an edge onto it states a relation to something
 * the substrate has stopped holding.
 */
const CURRENT_RETAINED_NODES = [
  'UNWIND $ids AS id',
  `MATCH (n:${MEMORY_LABEL} { id: id })`,
  `WHERE ${currentOnly('n')}`,
  `  AND coalesce(n.${STRUCTURAL_PROPERTY}, false) = false`,
  'RETURN n.id AS id',
].join('\n');

export async function currentRetainedNodesInTransaction(
  tx: GraphTransaction,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Set();
  }
  return new Set(await tx.run(CURRENT_RETAINED_NODES, { ids: unique }, (row) => row.id as string));
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

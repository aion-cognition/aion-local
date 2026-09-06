import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, closeFragment } from './bitemporal.js';
import { readFirst, runWrite, type GraphStatement, type GraphTransaction } from './connection.js';
import { assertPositiveInt } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { SUMMARIZED_BY_TYPE } from './narrative-queries.js';
import { toGraphDateTime, toGraphInteger, type Row } from './values.js';

/**
 * Closes the summarization edges into a narrative that no longer stands. A version the next
 * close supersedes keeps every `SUMMARIZED_BY` edge its episodes wrote, so each rewrite of a
 * long session leaves another full set of them open: the traversal still walks episode to dead
 * narrative, and the neighbour count still prices every one of those hops. Most of the stored
 * mass on a substrate that has been narrating for a while is that residue rather than the
 * handful of edges doing the work.
 *
 * Closing is bitemporal, never a delete: the row stays, invisible to a default read, still
 * traversable under `as_of` and `knew_at` (`adjacency.ts` reads it that way). `DERIVES_FROM`,
 * the `SUPERSEDES` lineage, and the narrative node with its citations are untouched, so what a
 * closed version claimed and what replaced it both stay readable. `SUMMARIZED_BY` sits in
 * `PROTECTED_RELATIONSHIP_TYPES`, which keeps decay and `edge_prune` off it; that protection is
 * about weight, and this close follows the node's own supersession rather than a weight rule.
 */

export type ClosedNarrativeEdge = {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
};

function mapClosedEdge(row: Row): ClosedNarrativeEdge {
  return {
    id: row.id as string,
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
  };
}

const CLOSED_EDGE_RETURN =
  'RETURN r.id AS id, startNode(r).id AS sourceId, endNode(r).id AS targetId';

export type NarrativeEdgeCloseInput = {
  /** The narratives being superseded; edges into anything else are left alone. */
  readonly narrativeIds: readonly string[];
  /** The world time the narratives stopped standing, which is when they stopped summarizing. */
  readonly validUntil: Date;
  /** The moment the substrate stops holding the edge, which is the write. */
  readonly txUntil: Date;
};

/**
 * `valid_until IS NULL` selects only what is still open, and `closeFragment`'s `coalesce` keeps
 * the first close's stamps, so running this twice over the same narratives writes nothing the
 * second time. That is what makes an interrupted supersession recoverable: the retry closes the
 * edges the first attempt missed and leaves the rest exactly as it found them.
 */
export function buildNarrativeEdgeClose(input: NarrativeEdgeCloseInput): GraphStatement {
  const cypher = [
    'UNWIND $narrativeIds AS narrativeId',
    `MATCH (:${BASE_NODE_LABEL})-[r:${SUMMARIZED_BY_TYPE}]->(:Narrative { id: narrativeId })`,
    `WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `SET ${closeFragment('r')}`,
    CLOSED_EDGE_RETURN,
  ].join('\n');

  return {
    cypher,
    parameters: {
      narrativeIds: [...new Set(input.narrativeIds)],
      validUntil: toGraphDateTime(input.validUntil),
      txUntil: toGraphDateTime(input.txUntil),
    },
  };
}

/**
 * Joined to the transaction that closes the narratives themselves, so a reader never sees a
 * superseded version still summarizing its session.
 */
export async function closeNarrativeEdgesInTransaction(
  tx: GraphTransaction,
  input: NarrativeEdgeCloseInput,
): Promise<ClosedNarrativeEdge[]> {
  if (input.narrativeIds.length === 0) {
    return [];
  }
  const statement = buildNarrativeEdgeClose(input);
  return tx.run(statement.cypher, statement.parameters, mapClosedEdge);
}

/**
 * The inverse, for a close somebody undid. `unsupersede` restores a narrative's currency by
 * dropping the two stamps the close wrote, and these edges have to come back with it: a
 * narrative current again that no episode can reach is reachable by id and by nothing else,
 * and the backlog repair will not find it either, since that scan only closes edges into
 * narratives that are still closed.
 *
 * Attribution is the narrative itself. An edge into it is closed only when it is closed, by
 * the supersession or by the repair standing in for one, so every closed edge into a narrative
 * being reopened belongs to the close being undone.
 *
 * `REMOVE` rather than a later interval, matching how `unsupersede.ts` restores a node: both
 * timelines say the association holds again. Provenance, signals, strength, and count are not
 * touched, so the edge comes back as the one that was there. `valid_until IS NOT NULL` is what
 * makes a second call match nothing.
 */
export function buildNarrativeEdgeReopen(narrativeIds: readonly string[]): GraphStatement {
  const cypher = [
    'UNWIND $narrativeIds AS narrativeId',
    `MATCH (:${BASE_NODE_LABEL})-[r:${SUMMARIZED_BY_TYPE}]->(:Narrative { id: narrativeId })`,
    `WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`,
    `REMOVE r.${BITEMPORAL_PROPERTIES.validUntil}, r.${BITEMPORAL_PROPERTIES.txUntil}`,
    CLOSED_EDGE_RETURN,
  ].join('\n');

  return { cypher, parameters: { narrativeIds: [...new Set(narrativeIds)] } };
}

/** Joined to the transaction that restores the narrative's own currency. */
export async function reopenNarrativeEdgesInTransaction(
  tx: GraphTransaction,
  narrativeIds: readonly string[],
): Promise<ClosedNarrativeEdge[]> {
  if (narrativeIds.length === 0) {
    return [];
  }
  const statement = buildNarrativeEdgeReopen(narrativeIds);
  return tx.run(statement.cypher, statement.parameters, mapClosedEdge);
}

export type StaleNarrativeEdgeInput = {
  /** Caps how many edges one call closes. */
  readonly batchSize: number;
  readonly now: Date;
};

/**
 * The backlog left by every supersession that ran before the close above existed, and by the
 * rollup path, which absorbs a session narrative without touching the episode edges into it.
 * Ordered by the narrative's own close so the oldest residue drains first, and bounded by
 * `batchSize` so one run is a fixed amount of work whatever the backlog is.
 *
 * The edge takes its narrative's `valid_until` rather than the repair's clock: the association
 * stopped holding when the narrative stopped standing, not when the sweep noticed. System time
 * is the sweep, because that is when the substrate stopped holding it. `$validUntil` is the
 * floor for a narrative closed without one, which no writer here produces.
 */
export function buildStaleNarrativeEdgeClose(input: StaleNarrativeEdgeInput): GraphStatement {
  assertPositiveInt('batchSize', input.batchSize);
  const { validUntil } = BITEMPORAL_PROPERTIES;

  const cypher = [
    `MATCH (:${BASE_NODE_LABEL})-[r:${SUMMARIZED_BY_TYPE}]->(n:Narrative)`,
    `WHERE r.${validUntil} IS NULL AND n.${validUntil} IS NOT NULL`,
    `WITH r, n ORDER BY n.${validUntil} ASC, r.id ASC`,
    'LIMIT $batchSize',
    `SET r.${validUntil} = coalesce(r.${validUntil}, n.${validUntil}, $validUntil),`,
    `    r.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(r.${BITEMPORAL_PROPERTIES.txUntil}, $txUntil)`,
    CLOSED_EDGE_RETURN,
  ].join('\n');

  return {
    cypher,
    parameters: {
      batchSize: toGraphInteger(input.batchSize),
      validUntil: toGraphDateTime(input.now),
      txUntil: toGraphDateTime(input.now),
    },
  };
}

/**
 * Closes up to `batchSize` stale edges and answers with exactly the ones it closed. A second
 * call over an already-repaired substrate answers `[]`, since a closed edge no longer matches.
 */
export async function closeStaleNarrativeEdges(
  driver: Driver,
  input: StaleNarrativeEdgeInput,
): Promise<ClosedNarrativeEdge[]> {
  const statement = buildStaleNarrativeEdgeClose(input);
  return runWrite(driver, statement.cypher, statement.parameters, mapClosedEdge);
}

export type NarrativeEdgeCounts = {
  /** Open edges into a narrative that still stands: the fan-out traversal actually needs. */
  readonly active: number;
  /** Open edges into a narrative something has closed: the churn this module removes. */
  readonly stale: number;
};

/** The split the operation reports, which is active fan-out measured apart from stored mass. */
export function buildNarrativeEdgeCounts(): GraphStatement {
  const { validUntil } = BITEMPORAL_PROPERTIES;
  const cypher = [
    `MATCH ()-[r:${SUMMARIZED_BY_TYPE}]->(n:Narrative)`,
    `WHERE r.${validUntil} IS NULL`,
    `RETURN count(CASE WHEN n.${validUntil} IS NULL THEN 1 END) AS active,`,
    `       count(CASE WHEN n.${validUntil} IS NOT NULL THEN 1 END) AS stale`,
  ].join('\n');

  return { cypher, parameters: {} };
}

export async function countNarrativeEdges(driver: Driver): Promise<NarrativeEdgeCounts> {
  const statement = buildNarrativeEdgeCounts();
  const row = await readFirst(driver, statement.cypher, statement.parameters, (r: Row) => ({
    active: r.active as number,
    stale: r.stale as number,
  }));
  return row ?? { active: 0, stale: 0 };
}

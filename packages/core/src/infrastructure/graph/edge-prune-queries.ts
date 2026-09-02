import neo4j, { type Driver } from 'neo4j-driver';

import { CO_OCCURS_TYPE, SIMILAR_TYPE } from './association-queries.js';
import { BITEMPORAL_PROPERTIES, closeFragment } from './bitemporal.js';
import { readFirst, runWrite, type GraphStatement } from './connection.js';
import { assertPositiveInt, assertProportion } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * Closes association edges the decay sweep has already driven to the
 * floor and nothing has reinforced in a while. Decay's own clamp keeps such an edge traversable
 * forever (`w' = max(floor, w - eta_decay * decay)`), but a floor `CO_OCCURS` hop propagates at
 * `0.5 * 0.1 * 0.7 = 0.035`, under `activation.minActivation` (0.1): the traversability decay
 * preserves does not exist, and the adjacency read (`adjacency.ts`) still fetches and prices
 * every one of these edges, since its strength cutoff is inclusive of the floor. This module is
 * what actually closes that measured mass; `adjacency.ts` excludes a closed edge from its own
 * read so the two halves of the fix meet.
 *
 * Scoped to `CO_OCCURS` and `SIMILAR`, the two types `association-queries.ts` writes, not to
 * every unprotected edge decay reaches. `CAUSES`, `CONTRADICTS`, and the rest of the
 * semantic-relationships stage's output are typed knowledge claims that stay true even faded,
 * so they are excluded here the same way the backbone and provenance types already are.
 * `edge-prune-queries.test.ts` pins that this list shares nothing with
 * `PROTECTED_RELATIONSHIP_TYPES`.
 *
 * "Last reinforcement" reads `updated_at`, the same property decay treats as "last touched":
 * the merge policy (`edges.ts`) sets it on every write and the Hebbian reinforcement step
 * (`edge-weights.ts`) sets it on every bounded nudge, and neither the sweep's own scan nor this
 * close touches it. Nothing on the edge distinguishes a fold-time reinforcement from a
 * write-time observation; both land on the one property, so `updated_at` is used as-is rather
 * than invented apart from it.
 *
 * Closing is bitemporal (`valid_until`/`tx_until`, via `bitemporal.ts`'s own `closeFragment`),
 * never `DETACH DELETE`: the row stays, invisible to a default read, present under `as_of`. A
 * later co-occurrence or similarity write for the same pair reaches the closed relationship
 * through `edges.ts`'s MERGE (which matches by type and endpoints, not by validity), and that
 * merge policy reopens it: the `ON MATCH` branch clears `valid_until`/`tx_until` and resets
 * strength through the create expression rather than resuming from the floor-clamped remnant
 * this close left behind. A reinforcement nudge (`edge-weights.ts`) reopens the same edge the
 * same way. A closed edge's undo path is the next real signal, not the passage of time.
 */
export const PRUNABLE_ASSOCIATION_TYPES: readonly RelationshipType[] = [
  CO_OCCURS_TYPE,
  SIMILAR_TYPE,
];

export type EdgePruneInput = {
  /** Caps how many eligible edges one call closes. */
  readonly batchSize: number;
  readonly weightFloor: number;
  /** Days since `updated_at` an edge must have gone unreinforced before it is eligible. */
  readonly unreinforcedDays: number;
  readonly now?: Date;
};

export type PrunedEdge = {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
};

/**
 * Floor and age are both inclusive at the boundary, matching the floor's own inclusive read in
 * `adjacency.ts`: an edge unreinforced for exactly `unreinforcedDays` is eligible, not one day
 * later. `updated_at` coalesces to `$now` when absent, reading as zero days stale rather than
 * poisoning the duration arithmetic, the same null handling the decay sweep uses.
 */
export function buildEdgePruneClose(input: EdgePruneInput): GraphStatement {
  assertPositiveInt('batchSize', input.batchSize);
  assertProportion('weightFloor', input.weightFloor);
  assertPositiveInt('unreinforcedDays', input.unreinforcedDays);

  const source = readModeFragment(withCurrency(), 'a', 'src');
  const target = readModeFragment(withCurrency(), 'b', 'tgt');
  const now = input.now ?? new Date();

  const cypher = [
    `MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`,
    'WHERE type(r) IN $prunableTypes AND NOT type(r) IN $protected',
    `  AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    '  AND coalesce(r.strength, $weightFloor) <= $weightFloor',
    '  AND duration.inDays(coalesce(r.updated_at, $now), $now).days >= $unreinforcedDays',
    `  AND ${source.where} AND ${target.where}`,
    'WITH r ORDER BY r.updated_at ASC, r.id ASC',
    'LIMIT $batchSize',
    `SET ${closeFragment('r')}`,
    'RETURN r.id AS id, type(r) AS type, startNode(r).id AS sourceId, endNode(r).id AS targetId',
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...source.parameters,
      ...target.parameters,
      prunableTypes: [...PRUNABLE_ASSOCIATION_TYPES],
      protected: [...PROTECTED_RELATIONSHIP_TYPES],
      weightFloor: input.weightFloor,
      unreinforcedDays: input.unreinforcedDays,
      batchSize: neo4j.int(input.batchSize),
      now: toGraphDateTime(now),
      // A prune closes an edge because it went unreinforced up to the sweep, so the world
      // time it stops holding and the moment the substrate stops holding it are one value.
      validUntil: toGraphDateTime(now),
      txUntil: toGraphDateTime(now),
    },
  };
}

function mapPrunedEdge(row: Row): PrunedEdge {
  return {
    id: row.id as string,
    type: row.type as string,
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
  };
}

/**
 * Closes up to `batchSize` eligible edges and returns exactly the ones it closed: unlike decay's
 * scan, eligibility is the whole `WHERE` clause here, so nothing this call examines survives
 * unclosed. A second call over the same substrate returns `[]`, since a closed edge no longer
 * matches `valid_until IS NULL`.
 */
export async function closeEligibleAssociationEdges(
  driver: Driver,
  input: EdgePruneInput,
): Promise<PrunedEdge[]> {
  const statement = buildEdgePruneClose(input);
  return runWrite(driver, statement.cypher, statement.parameters, mapPrunedEdge);
}

export type EdgeFloorBandCounts = {
  readonly atFloor: number;
  readonly aboveFloor: number;
};

/** The same open-edge population the close statement scans, split at the floor rather than closed. */
export function buildEdgeFloorBandCounts(weightFloor: number): GraphStatement {
  assertProportion('weightFloor', weightFloor);
  const source = readModeFragment(withCurrency(), 'a', 'src');
  const target = readModeFragment(withCurrency(), 'b', 'tgt');

  const cypher = [
    `MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`,
    `WHERE type(r) IN $prunableTypes AND r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND ${source.where} AND ${target.where}`,
    'WITH coalesce(r.strength, $weightFloor) AS strength',
    'RETURN count(CASE WHEN strength <= $weightFloor THEN 1 END) AS atFloor,',
    '       count(CASE WHEN strength > $weightFloor THEN 1 END) AS aboveFloor',
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...source.parameters,
      ...target.parameters,
      prunableTypes: [...PRUNABLE_ASSOCIATION_TYPES],
      weightFloor,
    },
  };
}

/** The ledger's before/after histogram: open `CO_OCCURS`/`SIMILAR` edges split at the floor. */
export async function countEdgesByFloorBand(
  driver: Driver,
  weightFloor: number,
): Promise<EdgeFloorBandCounts> {
  const statement = buildEdgeFloorBandCounts(weightFloor);
  const row = await readFirst(driver, statement.cypher, statement.parameters, (r: Row) => ({
    atFloor: r.atFloor as number,
    aboveFloor: r.aboveFloor as number,
  }));
  return row ?? { atFloor: 0, aboveFloor: 0 };
}

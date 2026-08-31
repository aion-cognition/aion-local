import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { type GraphStatement, type GraphTransaction, runWrite } from './connection.js';
import { GraphNodeNotFoundError, GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { isRelationshipType, normalizeEndpoints, type RelationshipType } from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * How a repeated write moves an edge's strength.
 *
 * `max` is the default and the right rule for a writer restating a fact: the strongest claim
 * anyone has made about the edge stands, and saying it again changes nothing.
 *
 * `bounded_step` is for a writer whose every call is one observation rather than a claim about
 * the total. `strength` is then what a single observation is worth on its own, and the edge
 * moves `w' = w + s * (1 - w)`: the first observation lands at `s`, later ones close the
 * remaining gap and never reach 1. It is the rule co-occurrence needs, because an episode
 * naming twenty entities asserts far less about any one of its 190 pairs than an episode
 * naming two asserts about its only pair, and under `max` both land at the same number.
 */
export type EdgeStrengthPolicy = 'max' | 'bounded_step';

export type EdgeUpsert = {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  /** A target strength under `max`; what one observation is worth under `bounded_step`. */
  readonly strength: number;
  /** Defaults to `max`. */
  readonly strengthPolicy?: EdgeStrengthPolicy;
  /**
   * Lower clamp under `bounded_step`, so a heavily discounted observation still writes a
   * traversable edge rather than one recall treats as absent. Ignored under `max`.
   */
  readonly weightFloor?: number;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  /**
   * Summed by the merge policy, so it is the one field a repeated identical write moves.
   * Observation edges pass the number of observations (default 1); structural edges that
   * must be a total no-op on re-run pass 0.
   */
  readonly count?: number;
  readonly rationale?: string;
  readonly id?: string;
  readonly now?: Date;
};

export type UpsertedEdge = {
  readonly id: string;
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly strength: number;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly provenance: readonly string[];
  readonly count: number;
  readonly rationale?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

function assertProportion(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GraphWriteError(`${name} must be between 0 and 1, received ${value}`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The strength expression each policy writes: the value a fresh edge is created with, and the
 * value an ordinary repeat write (one that lands on an already-open edge) moves it to. Bare
 * expressions rather than full assignments, so the `ON MATCH` reopen branch below can fall
 * back to the create expression without restating the merge policy's own cases.
 */
function strengthPolicyFragments(policy: EdgeStrengthPolicy): {
  readonly onCreate: string;
  readonly onMatch: string;
} {
  if (policy === 'max') {
    return {
      onCreate: '$strength',
      onMatch:
        'CASE WHEN coalesce(r.strength, 0.0) >= $strength THEN r.strength ELSE $strength END',
    };
  }
  const stepped = 'coalesce(r.strength, 0.0) + $strength * (1.0 - coalesce(r.strength, 0.0))';
  return {
    onCreate: 'CASE WHEN $strength < $weightFloor THEN $weightFloor ELSE $strength END',
    onMatch: `CASE WHEN ${stepped} > 1.0 THEN 1.0 WHEN ${stepped} < $weightFloor THEN $weightFloor ELSE ${stepped} END`,
  };
}

/**
 * The one merge policy every relationship write goes through: strength by the write's own
 * `strengthPolicy` (max by default), max(confidence), set-union(signals),
 * set-union(provenance), sum(count), earliest created_at preserved, updated_at refreshed. The
 * unions are list comprehensions rather than APOC, which is not installed and is not a
 * dependency this project takes on.
 *
 * A matched edge `edge_prune` has bitemporally closed reopens as part of this write rather
 * than staying invisible while still absorbing it: the `ON MATCH` branch below clears
 * `valid_until`/`tx_until` and resets strength through the create expression. An already-open
 * matched edge takes neither path and writes exactly as it always has.
 *
 * Endpoints resolve through `BASE_NODE_LABEL` because an unlabelled `{ id: … }` match has
 * no index to seek: every relationship write would scan the whole graph twice.
 */
export function buildEdgeUpsert(input: EdgeUpsert): GraphStatement {
  if (!isRelationshipType(input.type)) {
    throw new GraphWriteError(`unknown relationship type ${String(input.type)}`);
  }
  if (input.sourceId.length === 0 || input.targetId.length === 0) {
    throw new GraphWriteError('edge endpoints must both carry a node id');
  }
  assertProportion('strength', input.strength);
  assertProportion('confidence', input.confidence);
  const policy = input.strengthPolicy ?? 'max';
  const weightFloor = input.weightFloor ?? 0;
  assertProportion('weightFloor', weightFloor);

  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 0) {
    throw new GraphWriteError(`count must be a non-negative integer, received ${count}`);
  }

  const endpoints = normalizeEndpoints(input.type, {
    sourceId: input.sourceId,
    targetId: input.targetId,
  });
  const now = input.now ?? new Date();
  const hasRationale = input.rationale !== undefined;

  const strength = strengthPolicyFragments(policy);
  const reopenCondition = `r.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL`;

  const onCreate = [
    'r.id = $id',
    'r.created_at = $now',
    'r.updated_at = $now',
    `r.strength = ${strength.onCreate}`,
    'r.confidence = $confidence',
    'r.signals = $signals',
    'r.provenance = $provenance',
    'r.count = $count',
    ...(hasRationale ? ['r.rationale = $rationale'] : []),
  ];

  const onMatch = [
    'r.updated_at = $now',
    // A reopen resets strength through the create expression instead of moving the match
    // expression's own remnant: the edge was closed because that remnant sat at the floor with
    // nothing to show for it, so restarting it under the match rule would leave it there again.
    `r.strength = CASE WHEN ${reopenCondition} THEN ${strength.onCreate} ELSE ${strength.onMatch} END`,
    `r.${BITEMPORAL_PROPERTIES.validUntil} = CASE WHEN ${reopenCondition} THEN null ELSE r.${BITEMPORAL_PROPERTIES.validUntil} END`,
    `r.${BITEMPORAL_PROPERTIES.txUntil} = CASE WHEN ${reopenCondition} THEN null ELSE r.${BITEMPORAL_PROPERTIES.txUntil} END`,
    'r.confidence = CASE WHEN coalesce(r.confidence, 0.0) >= $confidence THEN r.confidence ELSE $confidence END',
    'r.signals = coalesce(r.signals, []) + [s IN $signals WHERE NOT s IN coalesce(r.signals, [])]',
    'r.provenance = coalesce(r.provenance, []) + [p IN $provenance WHERE NOT p IN coalesce(r.provenance, [])]',
    'r.count = coalesce(r.count, 0) + $count',
    ...(hasRationale ? ['r.rationale = coalesce(r.rationale, $rationale)'] : []),
  ];

  const cypher = [
    `MATCH (a:${BASE_NODE_LABEL} { id: $sourceId })`,
    `MATCH (b:${BASE_NODE_LABEL} { id: $targetId })`,
    `MERGE (a)-[r:${input.type}]->(b)`,
    `ON CREATE SET ${onCreate.join(', ')}`,
    `ON MATCH SET ${onMatch.join(', ')}`,
    'RETURN r.id AS id, a.id AS sourceId, b.id AS targetId, r.strength AS strength,',
    '       r.confidence AS confidence, r.signals AS signals, r.provenance AS provenance,',
    '       r.count AS count, r.rationale AS rationale, r.created_at AS createdAt,',
    '       r.updated_at AS updatedAt',
  ].join('\n');

  return {
    cypher,
    parameters: {
      sourceId: endpoints.sourceId,
      targetId: endpoints.targetId,
      id: input.id ?? randomUUID(),
      now: toGraphDateTime(now),
      strength: input.strength,
      weightFloor,
      confidence: input.confidence,
      signals: uniqueStrings(input.signals),
      provenance: uniqueStrings(input.provenance),
      count,
      ...(hasRationale ? { rationale: input.rationale } : {}),
    },
  };
}

function mapUpsertedEdge(type: RelationshipType, row: Row): UpsertedEdge {
  const { rationale } = row;
  return {
    id: row.id as string,
    type,
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
    strength: row.strength as number,
    confidence: row.confidence as number,
    signals: row.signals as string[],
    provenance: row.provenance as string[],
    count: row.count as number,
    ...(typeof rationale === 'string' ? { rationale } : {}),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

function firstEdge(input: EdgeUpsert, rows: readonly UpsertedEdge[]): UpsertedEdge {
  const edge = rows[0];
  if (edge === undefined) {
    throw new GraphNodeNotFoundError([input.sourceId, input.targetId], `${input.type} upsert`);
  }
  return edge;
}

export async function upsertEdge(driver: Driver, input: EdgeUpsert): Promise<UpsertedEdge> {
  const statement = buildEdgeUpsert(input);
  const rows = await runWrite(driver, statement.cypher, statement.parameters, (row) =>
    mapUpsertedEdge(input.type, row),
  );
  return firstEdge(input, rows);
}

/** Same policy inside a caller's transaction; `supersede` uses this to close a node and link its replacement atomically. */
export async function upsertEdgeInTransaction(
  tx: GraphTransaction,
  input: EdgeUpsert,
): Promise<UpsertedEdge> {
  const statement = buildEdgeUpsert(input);
  const rows = await tx.run(statement.cypher, statement.parameters, (row) =>
    mapUpsertedEdge(input.type, row),
  );
  return firstEdge(input, rows);
}

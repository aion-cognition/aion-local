import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import {
  type GraphStatement,
  type GraphTransaction,
  runWrite,
} from './connection.js';
import { GraphNodeNotFoundError, GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import {
  isRelationshipType,
  normalizeEndpoints,
  type RelationshipType,
} from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

export type EdgeUpsert = {
  readonly type: RelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly strength: number;
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
 * The one merge policy every relationship write goes through: max(strength),
 * max(confidence), set-union(signals), set-union(provenance), sum(count), earliest
 * created_at preserved, updated_at refreshed. The unions are list comprehensions rather
 * than APOC, which is not installed and is not a dependency this project takes on.
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

  const onCreate = [
    'r.id = $id',
    'r.created_at = $now',
    'r.updated_at = $now',
    'r.strength = $strength',
    'r.confidence = $confidence',
    'r.signals = $signals',
    'r.provenance = $provenance',
    'r.count = $count',
    ...(hasRationale ? ['r.rationale = $rationale'] : []),
  ];

  const onMatch = [
    'r.updated_at = $now',
    'r.strength = CASE WHEN coalesce(r.strength, 0.0) >= $strength THEN r.strength ELSE $strength END',
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
      confidence: input.confidence,
      signals: uniqueStrings(input.signals),
      provenance: uniqueStrings(input.provenance),
      count,
      ...(hasRationale ? { rationale: input.rationale } : {}),
    },
  };
}

function mapUpsertedEdge(type: RelationshipType, row: Row): UpsertedEdge {
  const rationale = row.rationale;
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

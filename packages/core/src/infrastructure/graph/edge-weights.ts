import type { Driver } from 'neo4j-driver';
import { runWrite, type GraphStatement } from './connection.js';
import { GraphWriteError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { PROTECTED_RELATIONSHIP_TYPES } from './protected-relationships.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * The one write that moves an existing edge's weight in place. It is deliberately not the
 * merge policy in `edges.ts`: that policy takes the maximum of the old and new strength,
 * which is right for a writer restating a fact and wrong for plasticity, whose whole job is
 * to move a weight by a small amount in either direction.
 *
 * The bound lives in the Cypher rather than in the caller so the read and the write are one
 * statement. Two flushes racing on the same edge would otherwise both read the old weight and
 * the second would overwrite the first's step with its own.
 */

export type WeightReinforcement = {
  readonly sourceId: string;
  readonly targetId: string;
  /** The aggregated learning rate for this pair in this flush; the caller folds every signal into it. */
  readonly learningRate: number;
};

export type ReinforcedEdge = {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly strength: number;
};

export type ReinforceEdgeWeightsInput = {
  /** One entry per node pair, already aggregated: a repeated pair would apply two steps in one run. */
  readonly pairs: readonly WeightReinforcement[];
  readonly weightFloor: number;
  readonly now?: Date;
};

function assertProportion(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GraphWriteError(`${name} must be between 0 and 1, received ${value}`);
  }
}

function assertPair(pair: WeightReinforcement): void {
  if (pair.sourceId.length === 0 || pair.targetId.length === 0) {
    throw new GraphWriteError('reinforcement endpoints must both carry a node id');
  }
  assertProportion('learningRate', pair.learningRate);
}

/**
 * Undirected on purpose. A queue row records that two memories fired together and says
 * nothing about which way an edge between them happens to point, and several of the types
 * this touches store a canonical endpoint order that has no bearing on the signal.
 *
 * Both endpoints go through the currency predicate, so an edge onto a forgotten node is left
 * where it is: reinforcing it would strengthen a path recall already refuses to return.
 */
export function buildEdgeWeightReinforcement(input: ReinforceEdgeWeightsInput): GraphStatement {
  assertProportion('weightFloor', input.weightFloor);
  for (const pair of input.pairs) {
    assertPair(pair);
  }

  const source = readModeFragment(withCurrency(), 'a', 'src');
  const target = readModeFragment(withCurrency(), 'b', 'tgt');
  const now = input.now ?? new Date();

  const cypher = [
    'UNWIND $pairs AS pair',
    `MATCH (a:${BASE_NODE_LABEL} { id: pair.sourceId })-[r]-(b:${BASE_NODE_LABEL} { id: pair.targetId })`,
    `WHERE NOT type(r) IN $protected AND ${source.where} AND ${target.where}`,
    'WITH r, coalesce(r.strength, $weightFloor) AS w, pair.learningRate AS eta',
    'WITH r, w + eta * (1.0 - w) AS raw',
    'SET r.strength = CASE WHEN raw < $weightFloor THEN $weightFloor',
    '                      WHEN raw > 1.0 THEN 1.0',
    '                      ELSE raw END,',
    '    r.updated_at = $now',
    'RETURN r.id AS id, type(r) AS type, startNode(r).id AS sourceId,',
    '       endNode(r).id AS targetId, r.strength AS strength',
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...source.parameters,
      ...target.parameters,
      pairs: input.pairs.map((pair) => ({
        sourceId: pair.sourceId,
        targetId: pair.targetId,
        learningRate: pair.learningRate,
      })),
      protected: [...PROTECTED_RELATIONSHIP_TYPES],
      weightFloor: input.weightFloor,
      now: toGraphDateTime(now),
    },
  };
}

function mapReinforcedEdge(row: Row): ReinforcedEdge {
  return {
    id: row.id as string,
    type: row.type as string,
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
    strength: row.strength as number,
  };
}

/**
 * Every unprotected edge between each pair, moved one bounded step. A pair with no edge
 * between it contributes nothing and is not an error: the queue records co-activation, and
 * two memories can fire together without being linked.
 */
export async function reinforceEdgeWeights(
  driver: Driver,
  input: ReinforceEdgeWeightsInput,
): Promise<ReinforcedEdge[]> {
  if (input.pairs.length === 0) {
    return [];
  }
  const statement = buildEdgeWeightReinforcement(input);
  return runWrite(driver, statement.cypher, statement.parameters, mapReinforcedEdge);
}

import neo4j, { type Driver } from 'neo4j-driver';
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

/**
 * Decay's sibling write, not a parameter on the reinforcement builder above: reinforcement
 * is handed named pairs and matches exactly those, while decay has no pairs to be handed and
 * instead scans for its own candidates, oldest-touched first. The floor is a hard clamp
 * here rather than the lower bound reinforcement only approaches from below, since decay
 * moves a weight down and the clamp is what stops it going past the floor.
 */
export type WeightDecayInput = {
  /** Caps how many of the stalest unprotected edges one call touches. */
  readonly batchSize: number;
  /** eta_decay in the bell curve. */
  readonly decayRate: number;
  /** The staleness, in days, where the curve peaks. */
  readonly peakDays: number;
  /** The curve's spread around the peak, in days. */
  readonly sigma: number;
  readonly weightFloor: number;
  readonly now?: Date;
};

export type DecayedEdge = {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly strength: number;
  /** The weight before this call's step, so a caller can tell a moved edge from one already at the floor. */
  readonly previousStrength: number;
};

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphWriteError(`${name} must be a positive integer, received ${value}`);
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GraphWriteError(`${name} must be a positive number, received ${value}`);
  }
}

/**
 * A scan over the graph's own stalest unprotected edges rather than an `UNWIND` of named
 * pairs: decay has no queue to draw candidates from, so the query finds them. Staleness is
 * `duration.inDays(r.updated_at, $now)`, computed in the same statement that writes the
 * result so the read and the write never race, matching the reinforcement builder above.
 *
 * `ORDER BY ... LIMIT` before the write is what makes a bounded run resumable rather than
 * repeating: every edge this call touches gets a fresh `updated_at`, so the next call's scan
 * naturally ranks it behind whatever is still stale.
 */
export function buildEdgeWeightDecay(input: WeightDecayInput): GraphStatement {
  assertProportion('weightFloor', input.weightFloor);
  assertProportion('decayRate', input.decayRate);
  assertPositiveInt('batchSize', input.batchSize);
  assertPositiveInt('peakDays', input.peakDays);
  assertPositive('sigma', input.sigma);

  const source = readModeFragment(withCurrency(), 'a', 'src');
  const target = readModeFragment(withCurrency(), 'b', 'tgt');
  const now = input.now ?? new Date();

  const cypher = [
    `MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`,
    `WHERE NOT type(r) IN $protected AND ${source.where} AND ${target.where}`,
    'WITH r, duration.inDays(r.updated_at, $now).days AS daysSinceAccess',
    'ORDER BY daysSinceAccess DESC',
    'LIMIT $batchSize',
    'WITH r, exp(-1.0 * ((daysSinceAccess - $peakDays) ^ 2.0) / (2.0 * ($sigma ^ 2.0))) AS decay',
    'WITH r, coalesce(r.strength, $weightFloor) AS before, decay',
    'WITH r, before,',
    '     CASE WHEN before - $decayRate * decay < $weightFloor THEN $weightFloor',
    '          ELSE before - $decayRate * decay END AS after',
    'SET r.strength = after,',
    '    r.updated_at = $now',
    'RETURN r.id AS id, type(r) AS type, startNode(r).id AS sourceId,',
    '       endNode(r).id AS targetId, after AS strength, before AS previousStrength',
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...source.parameters,
      ...target.parameters,
      protected: [...PROTECTED_RELATIONSHIP_TYPES],
      // LIMIT rejects a float outright, and a plain JS number crosses the driver as one.
      batchSize: neo4j.int(input.batchSize),
      decayRate: input.decayRate,
      peakDays: input.peakDays,
      sigma: input.sigma,
      weightFloor: input.weightFloor,
      now: toGraphDateTime(now),
    },
  };
}

function mapDecayedEdge(row: Row): DecayedEdge {
  return {
    id: row.id as string,
    type: row.type as string,
    sourceId: row.sourceId as string,
    targetId: row.targetId as string,
    strength: row.strength as number,
    previousStrength: row.previousStrength as number,
  };
}

/**
 * The `batchSize` stalest unprotected edges, each moved one bell-curve step toward the
 * floor. A graph with nothing but protected edges, or none at all, returns an empty list.
 */
export async function decayEdgeWeights(
  driver: Driver,
  input: WeightDecayInput,
): Promise<DecayedEdge[]> {
  const statement = buildEdgeWeightDecay(input);
  return runWrite(driver, statement.cypher, statement.parameters, mapDecayedEdge);
}

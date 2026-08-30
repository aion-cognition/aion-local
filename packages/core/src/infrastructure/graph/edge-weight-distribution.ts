import type { Driver } from 'neo4j-driver';

import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import type { Row } from './values.js';

/**
 * One bounded read over the three evidence-scaled association types, for an operator to see
 * what plasticity has actually done to the graph's own weights. Not a hot-path query: every
 * unprotected `SIMILAR`, `CO_OCCURS`, and `RELATED_TO` edge is aggregated in one pass, which
 * is cheap next to a recall but not something a liveness probe should pay for on every hit.
 */

export const EDGE_WEIGHT_DISTRIBUTION_TYPES = [
  'SIMILAR',
  'CO_OCCURS',
  'RELATED_TO',
] as const satisfies readonly RelationshipType[];

export type EdgeWeightDistributionType = (typeof EDGE_WEIGHT_DISTRIBUTION_TYPES)[number];

export type EdgeWeightStats = {
  readonly count: number;
  readonly min: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
};

/** `undefined` for a type with no live edge, so an empty graph reads as unmeasured rather than as zero. */
export type EdgeWeightDistribution = Readonly<
  Record<EdgeWeightDistributionType, EdgeWeightStats | undefined>
>;

export function buildEdgeWeightDistribution(): GraphStatement {
  const source = readModeFragment(withCurrency(), 'a', 'src');
  const target = readModeFragment(withCurrency(), 'b', 'tgt');

  const cypher = [
    `MATCH (a:${BASE_NODE_LABEL})-[r]->(b:${BASE_NODE_LABEL})`,
    `WHERE type(r) IN $types AND ${source.where} AND ${target.where}`,
    'WITH type(r) AS relType, coalesce(r.strength, 0.0) AS strength',
    'RETURN relType,',
    '       count(strength) AS n,',
    '       min(strength) AS min,',
    '       percentileCont(strength, 0.1) AS p10,',
    '       percentileCont(strength, 0.5) AS p50,',
    '       percentileCont(strength, 0.9) AS p90,',
    '       max(strength) AS max',
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...source.parameters,
      ...target.parameters,
      types: [...EDGE_WEIGHT_DISTRIBUTION_TYPES],
    },
  };
}

type DistributionRow = {
  readonly type: EdgeWeightDistributionType;
  readonly stats: EdgeWeightStats;
};

function mapDistributionRow(row: Row): DistributionRow {
  return {
    type: row.relType as EdgeWeightDistributionType,
    stats: {
      count: row.n as number,
      min: row.min as number,
      p10: row.p10 as number,
      p50: row.p50 as number,
      p90: row.p90 as number,
      max: row.max as number,
    },
  };
}

/**
 * A type with at least one live edge gets a row; the rest are filled in as `undefined` rather
 * than left absent, so a caller can destructure every type without an `in` check.
 */
export async function edgeWeightDistribution(driver: Driver): Promise<EdgeWeightDistribution> {
  const statement = buildEdgeWeightDistribution();
  const rows = await runRead(driver, statement.cypher, statement.parameters, mapDistributionRow);
  const byType = new Map(rows.map((row) => [row.type, row.stats]));
  return Object.fromEntries(
    EDGE_WEIGHT_DISTRIBUTION_TYPES.map((type) => [type, byType.get(type)]),
  ) as EdgeWeightDistribution;
}

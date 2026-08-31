import type { Driver } from 'neo4j-driver';

import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import {
  readCurrencyAnnotation,
  readModeFragment,
  type CurrencyAnnotation,
  type ReadMode,
} from './read-modes.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * One edge out of the activation frontier, carrying everything spreading activation needs
 * to weight it: the relationship type, the two proportions SIMILAR and RELATED_TO scale by,
 * the neighbour's degree for hub inhibition, and the neighbour's currency annotation so a
 * superseded node arrives down-weightable rather than hidden.
 */
export type AdjacencyNeighbor = {
  /** The frontier node this edge was traversed from; activation propagates from its score. */
  readonly sourceId: string;
  readonly nodeId: string;
  readonly relationshipType: string;
  readonly strength: number;
  readonly confidence: number;
  readonly degree: number;
  readonly currency: CurrencyAnnotation;
  /** The Member and the global Workspace. Traversed like any node, never packed or reinforced. */
  readonly isStructural: boolean;
};

export type AdjacencyRequest = {
  /** The whole frontier batch: spreading activation fetches per iteration, never per node. */
  readonly frontier: readonly string[];
  /**
   * Expanded in an *earlier* ring. Spreading activation propagates to any neighbour not yet
   * visited, and a peer selected in this same batch is still in the frontier at that moment,
   * so excluding the batch here would drop exactly the intra-ring edges multi-path
   * accumulation is built on.
   */
  readonly visited: readonly string[];
  readonly mode: ReadMode;
  /**
   * `config.recall.associationStrength`: an edge under it stops being an edge at all. Reads
   * the same value `propagate` in `activation.ts` floors on, so the two cannot drift apart.
   */
  readonly minStrength: number;
  /**
   * `config.recall.adjacencyTopK`, applied per frontier node after the strength cutoff above.
   * A hub's every incident edge used to come back, each costing its own degree subquery; this
   * bounds that to the strongest K, which is what a hub's growing degree can no longer inflate.
   */
  readonly topK: number;
};

/** Namespaces the read mode's parameters and comprehension variables inside this statement. */
const NEIGHBOUR_PREFIX = 'nb';

/**
 * An edge written without the merge policy's proportions is traversed unweighted rather
 * than at zero, which would silently sever a path. Every writer sets both.
 * A float literal, so a coalesced value has the same type as a stored proportion.
 */
const ABSENT_PROPORTION = '1.0';

/**
 * One round-trip per frontier batch. `UNWIND` fans the batch out so each frontier node
 * seeks the `AionNode.id` constraint index, and the relationship pattern is undirected
 * because activation spreads both ways along an edge: direction is the semantics of the
 * relationship, not of the association it implies.
 *
 * The strength cutoff is a `WHERE` predicate rather than a filter downstream: an edge under
 * the floor used to be fetched, priced against a degree subquery, and only then discarded by
 * `propagate` in `activation.ts`. Edges sitting exactly at the floor still return, since the
 * floor is inclusive on both sides. That JS-side floor stays; it is the algorithm's own
 * contract on whatever an `AdjacencyFetch` hands it, not a mirror of this one query's
 * behaviour.
 *
 * The top-K cap is per frontier node, strongest edges first, and applied before the degree
 * subquery below rather than after: the classic Cypher shape for it is `ORDER BY` into one
 * `WITH` that groups on the node and slices a `collect()`, which is what the three `WITH`
 * clauses here do. Degree stays counted per neighbour rather than joined in, since hub
 * inhibition needs the node's connectivity in the whole graph, not the part this traversal
 * reached, and counting it after the cap is what keeps a hub's cost bounded by K rather than
 * by its whole degree.
 *
 * The read mode is spliced in against the neighbour: a forgotten node is suppressed here
 * and never enters the frontier, while a superseded one stays traversable and comes back
 * annotated with what replaced it.
 */
export function buildAdjacencyStatement(request: AdjacencyRequest): GraphStatement {
  const fragment = readModeFragment(request.mode, 'm', NEIGHBOUR_PREFIX);

  const cypher = [
    'UNWIND $frontier AS frontierId',
    `MATCH (n:${BASE_NODE_LABEL} { id: frontierId })-[r]-(m:${BASE_NODE_LABEL})`,
    'WHERE m.id <> frontierId AND NOT m.id IN $visited' +
      ` AND coalesce(r.strength, ${ABSENT_PROPORTION}) >= $minStrength AND ${fragment.where}`,
    `WITH frontierId, r, m, coalesce(r.strength, ${ABSENT_PROPORTION}) AS strength`,
    'ORDER BY strength DESC',
    'WITH frontierId, collect({ r: r, m: m, strength: strength })[0..$topK] AS ranked',
    'UNWIND ranked AS edge',
    'WITH frontierId, edge.r AS r, edge.m AS m, edge.strength AS strength',
    'RETURN frontierId AS sourceId,',
    '       m.id AS nodeId,',
    '       type(r) AS relationshipType,',
    '       strength,',
    `       coalesce(r.confidence, ${ABSENT_PROPORTION}) AS confidence,`,
    '       COUNT { (m)--() } AS degree,',
    `       m.${STRUCTURAL_PROPERTY} AS is_structural,`,
    `       ${fragment.projection}`,
  ].join('\n');

  return {
    cypher,
    parameters: {
      frontier: [...new Set(request.frontier)],
      visited: [...new Set(request.visited)],
      minStrength: request.minStrength,
      topK: toGraphInteger(request.topK),
      ...fragment.parameters,
    },
  };
}

function mapNeighbor(row: Row): AdjacencyNeighbor {
  return {
    sourceId: row.sourceId as string,
    nodeId: row.nodeId as string,
    relationshipType: row.relationshipType as string,
    strength: row.strength as number,
    confidence: row.confidence as number,
    degree: row.degree as number,
    currency: readCurrencyAnnotation(row),
    isStructural: row.is_structural === true,
  };
}

/**
 * Rows are deliberately not deduplicated: two frontier nodes reaching the same neighbour,
 * or two relationships of different types between the same pair, are two paths, and
 * multi-path accumulation is what the algorithm is built on.
 */
export async function fetchAdjacency(
  driver: Driver,
  request: AdjacencyRequest,
): Promise<readonly AdjacencyNeighbor[]> {
  if (request.frontier.length === 0) {
    return [];
  }
  const statement = buildAdjacencyStatement(request);
  return runRead(driver, statement.cypher, statement.parameters, mapNeighbor);
}

/**
 * Binds the driver, the read mode, and the two config-derived floors into the one-call shape
 * spreading activation asks for, so a caller states them once rather than at every frontier
 * ring. Structurally typed rather than named after `AdjacencyFetch`: that type lives in
 * `activation.ts`, and this module does not depend on the domain layer above it.
 */
export function adjacencyFetchFor(
  driver: Driver,
  mode: ReadMode,
  minStrength: number,
  topK: number,
): (
  request: Pick<AdjacencyRequest, 'frontier' | 'visited'>,
) => Promise<readonly AdjacencyNeighbor[]> {
  return (request) => fetchAdjacency(driver, { ...request, mode, minStrength, topK });
}

import type { Driver } from 'neo4j-driver';
import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { STRUCTURAL_PROPERTY } from './seed-queries.js';
import {
  readCurrencyAnnotation,
  readModeFragment,
  type CurrencyAnnotation,
  type ReadMode,
} from './read-modes.js';
import type { Row } from './values.js';

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
 * Degree is counted per neighbour rather than joined in, since hub inhibition needs the
 * node's connectivity in the whole graph, not the part of it this traversal has reached.
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
    `WHERE m.id <> frontierId AND NOT m.id IN $visited AND ${fragment.where}`,
    'RETURN frontierId AS sourceId,',
    '       m.id AS nodeId,',
    '       type(r) AS relationshipType,',
    `       coalesce(r.strength, ${ABSENT_PROPORTION}) AS strength,`,
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

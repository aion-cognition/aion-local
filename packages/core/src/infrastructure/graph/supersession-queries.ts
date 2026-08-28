import neo4j, { type Driver } from 'neo4j-driver';
import type { Vector } from '../providers/types.js';
import { TEXT_NORM_PROPERTY, type CognitiveNodeLabel } from './cognitive-queries.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { GraphWriteError } from './errors.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { fromGraphVector, toGraphVector, type Row } from './values.js';

/**
 * The graph reads behind supersession detection (PRD §5.5). The stage decides what
 * contradicts what; this module knows which nodes carry a fact worth contradicting and how
 * to find the current neighbours of one.
 */

/**
 * The fact-bearing subset of the nine cognitive types. A Decision and an Insight each assert
 * something that a later episode can reverse; a Concept or an Event names something instead,
 * and reversing a name is a rename, not a supersession. `satisfies` fails to compile if a
 * label here drifts from the closed set `cognitive-queries.ts` writes.
 */
export const FACT_NODE_LABELS = ['Decision', 'Insight'] as const satisfies readonly CognitiveNodeLabel[];

export type FactNodeLabel = (typeof FACT_NODE_LABELS)[number];

export function isFactNodeLabel(value: string): value is FactNodeLabel {
  return (FACT_NODE_LABELS as readonly string[]).includes(value);
}

/** Appendix B provenance: which pipeline path closed the old node. */
export const SUPERSESSION_METHOD = 'reflection_supersession';

/** Procedure arguments and `LIMIT` are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export type EpisodeFactNode = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  /** Absent while the node is still a pending-vector marker; such a node cannot search for neighbours. */
  readonly contentVector?: Vector;
};

function episodeFactNodesStatement(): GraphStatement {
  const fragment = readModeFragment(withCurrency(), 'n');
  return {
    cypher: [
      'MATCH (:Episode { id: $episodeId })<-[:EXTRACTED_FROM]-(n)',
      `WHERE any(label IN labels(n) WHERE label IN $labels) AND ${fragment.where}`,
      'RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,',
      `       n.${MEMORY_PROPERTIES.text} AS text, n.${MEMORY_PROPERTIES.contentVector} AS content_vec`,
      `ORDER BY n.${TEXT_NORM_PROPERTY}, n.id`,
    ].join('\n'),
    parameters: fragment.parameters,
  };
}

/**
 * This episode's fact-bearing nodes, in a stable order so a bounded run always truncates the
 * same way. Returns `[]` when cognitive extraction has not run for the episode — the
 * not-assumed-to-have-run contract every stage after extraction follows.
 */
export async function findEpisodeFactNodes(
  driver: Driver,
  episodeId: string,
): Promise<EpisodeFactNode[]> {
  const statement = episodeFactNodesStatement();
  const rows = await runRead(
    driver,
    statement.cypher,
    { ...statement.parameters, episodeId, labels: [...FACT_NODE_LABELS] },
    mapEpisodeFactNode,
  );
  return rows.filter((row): row is EpisodeFactNode => row !== undefined);
}

function mapEpisodeFactNode(row: Row): EpisodeFactNode | undefined {
  const label = String(row.label ?? '');
  if (!isFactNodeLabel(label)) {
    return undefined;
  }
  const contentVector = fromGraphVector(row.content_vec);
  return {
    id: row.id as string,
    label,
    text: String(row.text ?? ''),
    ...(contentVector === undefined ? {} : { contentVector }),
  };
}

/**
 * Currency-filtered, unlike recall's currency-aware reads: a node that lost currency has
 * already been superseded, and closing it a second time asserts a lineage the substrate did
 * not observe. Same label as the subject, because a Decision and an Insight are different
 * kinds of claim and one does not replace the other.
 *
 * The scan is over the label rather than through `content_vec_idx` on purpose: the index
 * picks its k nearest before any predicate runs, so currency and the exclusion list would
 * spend slots on rows that cannot qualify. `vector.similarity.cosine` rescales onto [0,1] the
 * same way the index does, so the score is converted back to a true cosine before it meets a
 * threshold pinned as one. Matches `findSimilarCurrentEntities`.
 */
function contradictionCandidatesStatement(label: FactNodeLabel): string {
  return [
    `MATCH (n:${label})`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    '  AND NOT n.id IN $excludeIds',
    `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
    `  AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
    `WITH n, (2.0 * vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector) - 1.0) AS score`,
    'WHERE score >= $threshold',
    `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text, score`,
    'ORDER BY score DESC, n.id',
    'LIMIT $limit',
  ].join('\n');
}

/** Built once per label so the closed set is the only thing that ever reaches the label position. */
const CONTRADICTION_CANDIDATE_STATEMENTS = new Map<string, string>(
  FACT_NODE_LABELS.map((label) => [label, contradictionCandidatesStatement(label)]),
);

export type ContradictionCandidateInput = {
  readonly label: FactNodeLabel;
  readonly vector: Vector;
  /** The subject and its episode siblings: an episode's own nodes never supersede each other. */
  readonly excludeIds: readonly string[];
  readonly threshold: number;
  readonly limit: number;
};

export type ContradictionCandidate = {
  readonly id: string;
  readonly text: string;
  readonly score: number;
};

export async function findContradictionCandidates(
  driver: Driver,
  input: ContradictionCandidateInput,
): Promise<ContradictionCandidate[]> {
  const cypher = CONTRADICTION_CANDIDATE_STATEMENTS.get(input.label);
  if (cypher === undefined) {
    throw new GraphWriteError(`unknown fact node label ${input.label}`);
  }

  return runRead(
    driver,
    cypher,
    {
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    (row) => ({
      id: row.id as string,
      text: String(row.text ?? ''),
      score: row.score as number,
    }),
  );
}

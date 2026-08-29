import neo4j, { type Driver } from 'neo4j-driver';
import type { Vector } from '../providers/types.js';
import { TEXT_NORM_PROPERTY, type CognitiveNodeLabel } from './cognitive-queries.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { ENTITY_NAME_NORM_PROPERTY } from './seed-queries.js';
import { fromGraphVector, toGraphVector, type Row } from './values.js';

/**
 * The graph reads behind supersession detection (PRD §5.5). The stage decides what
 * contradicts what; this module knows which nodes carry a fact worth contradicting and how
 * to find the current neighbours of one.
 */

/**
 * The fact-bearing subset of the nine cognitive types. Decision and Insight assert a
 * position; Concept and Event are where operational parameters and their values actually
 * land, measured over the substrate, so a scan that omits them misses most real corrections.
 * `satisfies` fails to compile if a label here drifts from the closed set
 * `cognitive-queries.ts` writes.
 */
export const FACT_NODE_LABELS = [
  'Decision',
  'Insight',
  'Concept',
  'Event',
] as const satisfies readonly CognitiveNodeLabel[];

/** Cypher label expression over the fact set: one label scan per label, no full store scan. */
const FACT_LABEL_EXPRESSION = FACT_NODE_LABELS.join('|');

/**
 * A one- or two-character surface form is a substring of nearly every claim, so a name that
 * short cannot establish that two statements share a subject.
 */
const MIN_SUBJECT_NAME_LENGTH = 3;

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
  /** The stored fold, so the subject search matches names without recomputing it. */
  readonly textNorm: string;
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
      `       n.${MEMORY_PROPERTIES.text} AS text, n.${TEXT_NORM_PROPERTY} AS text_norm,`,
      `       n.${MEMORY_PROPERTIES.contentVector} AS content_vec`,
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
    textNorm: String(row.text_norm ?? ''),
    ...(contentVector === undefined ? {} : { contentVector }),
  };
}

export type ContradictionCandidate = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  readonly score: number;
  /** How the candidate was reached: a shared subject, or bare embedding proximity. */
  readonly matchedBy: CandidateMatch;
  /** The subject both statements name, when the shared-subject leg found it. */
  readonly sharedSubject?: string;
};

export type CandidateMatch = 'subject' | 'knn';

function toCandidate(row: Row, matchedBy: CandidateMatch): ContradictionCandidate | undefined {
  const label = String(row.label ?? '');
  if (!isFactNodeLabel(label)) {
    return undefined;
  }
  const sharedSubject = row.shared_subject === null ? '' : String(row.shared_subject ?? '');
  return {
    id: row.id as string,
    label,
    text: String(row.text ?? ''),
    score: typeof row.score === 'number' ? row.score : 0,
    matchedBy,
    ...(sharedSubject.length === 0 ? {} : { sharedSubject }),
  };
}

function mapSubjectCandidate(row: Row): ContradictionCandidate | undefined {
  return toCandidate(row, 'subject');
}

function mapVectorCandidate(row: Row): ContradictionCandidate | undefined {
  return toCandidate(row, 'knn');
}

/**
 * The claims that name what this one names. Both sides of a real reversal restate the same
 * subject, and the exercise measured that embedding proximity alone neither finds those pairs
 * (a concise restatement of a reversal scored 0.67) nor keeps unrelated ones out (three
 * false closures, all near neighbours on shared vocabulary).
 *
 * A subject is an Entity the source episode already extracted, so no keyword machinery
 * enters the path: the names are the model's own, the fold is the one the entity writer
 * stored, and the match is a substring test between two stored normalizations. The candidate
 * qualifies either by naming that entity in its own claim or by hanging off an episode that
 * mentions it.
 *
 * Cross-label on purpose: the substrate puts a parameter's baseline in a Concept and its
 * correction in a Decision, so requiring equal labels drops the pair that matters most.
 */
const SUBJECT_IDENTITY_CANDIDATES = [
  `MATCH (:Episode { id: $episodeId })-[:${ENTITY_MENTION_TYPE}]->(e:Entity)`,
  `WHERE e.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `  AND e.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `  AND size(e.${ENTITY_NAME_NORM_PROPERTY}) >= $minNameLength`,
  `  AND $subjectTextNorm CONTAINS e.${ENTITY_NAME_NORM_PROPERTY}`,
  `WITH collect(DISTINCT e.id) AS subjectIds, collect(DISTINCT e.${ENTITY_NAME_NORM_PROPERTY}) AS names`,
  'WITH subjectIds, names WHERE size(subjectIds) > 0',
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  '  AND NOT n.id IN $excludeIds',
  `  AND (head([name IN names WHERE n.${TEXT_NORM_PROPERTY} CONTAINS name]) IS NOT NULL`,
  '       OR EXISTS {',
  `         MATCH (n)-[:EXTRACTED_FROM]->(:Episode)-[:${ENTITY_MENTION_TYPE}]->(shared:Entity)`,
  '         WHERE shared.id IN subjectIds',
  '       })',
  `WITH n, names, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `     CASE WHEN n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `          AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `          THEN (2.0 * vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector) - 1.0)`,
  '          ELSE 0.0 END AS score',
  `RETURN n.id AS id, label, n.${MEMORY_PROPERTIES.text} AS text, score,`,
  `       head([name IN names WHERE n.${TEXT_NORM_PROPERTY} CONTAINS name]) AS shared_subject`,
  'ORDER BY score DESC, n.id',
  'LIMIT $limit',
].join('\n');

export type SubjectIdentityCandidateInput = {
  /** The episode whose entities define the subject set. */
  readonly episodeId: string;
  /** The subject claim's stored fold; an entity name has to appear inside it. */
  readonly subjectTextNorm: string;
  readonly vector: Vector;
  /** The subject and its episode siblings: an episode's own nodes never supersede each other. */
  readonly excludeIds: readonly string[];
  readonly limit: number;
};

export async function findSubjectIdentityCandidates(
  driver: Driver,
  input: SubjectIdentityCandidateInput,
): Promise<ContradictionCandidate[]> {
  const rows = await runRead(
    driver,
    SUBJECT_IDENTITY_CANDIDATES,
    {
      episodeId: input.episodeId,
      subjectTextNorm: input.subjectTextNorm,
      labels: [...FACT_NODE_LABELS],
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH),
      limit: toGraphInteger(input.limit),
    },
    mapSubjectCandidate,
  );
  return rows.filter((row): row is ContradictionCandidate => row !== undefined);
}

/**
 * The secondary widener, kept for the claims whose subject the entity extractor never named.
 * Currency-filtered, unlike recall's currency-aware reads: a node that lost currency has
 * already been superseded, and closing it a second time asserts a lineage the substrate did
 * not observe.
 *
 * The scan is over the labels rather than through `content_vec_idx` on purpose: the index
 * picks its k nearest before any predicate runs, so currency and the exclusion list would
 * spend slots on rows that cannot qualify. `vector.similarity.cosine` rescales onto [0,1] the
 * same way the index does, so the score is converted back to a true cosine before it meets a
 * threshold pinned as one. Matches `findSimilarCurrentEntities`.
 */
const CONTRADICTION_CANDIDATES = [
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  '  AND NOT n.id IN $excludeIds',
  `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
  `  AND size(n.${MEMORY_PROPERTIES.contentVector}) = $dimension`,
  `WITH n, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `     (2.0 * vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, $vector) - 1.0) AS score`,
  'WHERE score >= $threshold',
  `RETURN n.id AS id, label, n.${MEMORY_PROPERTIES.text} AS text, score, null AS shared_subject`,
  'ORDER BY score DESC, n.id',
  'LIMIT $limit',
].join('\n');

export type ContradictionCandidateInput = {
  readonly vector: Vector;
  /** The subject, its episode siblings, and anything the subject leg already returned. */
  readonly excludeIds: readonly string[];
  readonly threshold: number;
  readonly limit: number;
};

export async function findContradictionCandidates(
  driver: Driver,
  input: ContradictionCandidateInput,
): Promise<ContradictionCandidate[]> {
  const rows = await runRead(
    driver,
    CONTRADICTION_CANDIDATES,
    {
      labels: [...FACT_NODE_LABELS],
      excludeIds: [...input.excludeIds],
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    mapVectorCandidate,
  );
  return rows.filter((row): row is ContradictionCandidate => row !== undefined);
}

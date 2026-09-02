import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import {
  readCurrencyAnnotation,
  readModeFragment,
  type CurrencyAnnotation,
  type ReadFragment,
  type ReadMode,
} from './read-modes.js';
import { fromGraphVector, toGraphInteger, toGraphVector, type Row } from './values.js';
import { asCosine, CONTENT_VECTOR_INDEX, CONTEXT_VECTOR_INDEX } from './vector-indexes.js';
import { foldName } from '../../reflection/domain/name-fold.js';
import type { Vector } from '../providers/types.js';

/**
 * Four seed strategies, one query each, plus the two reads recall makes against ids it
 * already holds: hydrating an activated node into a candidate, and pulling content vectors
 * for MMR. They all splice the same `readModeFragment` in, so currency annotation and
 * forget suppression have exactly one definition behind every entry point into recall.
 */

export { CONTENT_VECTOR_INDEX } from './vector-indexes.js';
export { countMemoryNodes, memoryPopulation } from './memory-population.js';

/** Migration 002's fulltext index over `summary`, `text` and `name` on every memory label. */
export const CONTENT_FULLTEXT_INDEX = 'memory_content_fts';

export const ENTITY_NAME_PROPERTY = 'name';
export const ENTITY_NAME_NORM_PROPERTY = 'name_norm';

/** Written by entity extraction. Absent when extraction has not produced it yet, which the similarity leg handles as a normal state. */
export const ENTITY_NAME_VECTOR_PROPERTY = 'name_vec';

/**
 * `aliases` folded through the same `foldName` a cue is, the identity's own name excluded.
 * Derived rather than accumulated on its own, which is what makes a name a merge absorbed
 * reachable by the cue that used to reach it.
 */
export const ENTITY_ALIASES_NORM_PROPERTY = 'aliases_norm';

/** Written by recall's own access-tracking side effects; absent on a substrate that has served no recall yet. */
export const LAST_ACCESSED_PROPERTY = 'last_accessed';

/**
 * Set by `bootstrapBackbone` on the Member and the global Workspace. Those two are the graph's
 * connectivity backbone, not memories, so every read that feeds a MemoryPack carries the flag
 * and the pack drops them.
 */
export const STRUCTURAL_PROPERTY = 'is_structural';

/** An exact identity match is the strongest signal a seed can carry, so it enters the merge at the ceiling. */
export const EXACT_NAME_MATCH_SCORE = 1;

export type SeedCandidate = CurrencyAnnotation & {
  readonly id: string;
  readonly labels: readonly string[];
  /** Whichever of `summary`, `text`, `name` the node carries: the same three the fulltext index covers. */
  readonly content: string;
  readonly occurredAt?: Date;
  /**
   * `is_structural` from the backbone bootstrap. Absent on every node but the Member and the
   * global Workspace, which mirrors how the property is stored: written only where true.
   */
  readonly isStructural?: boolean;
  /** A Turn's parent episode. Absent on everything else, including the Episode itself. */
  readonly sourceEpisodeId?: string;
  /**
   * The node's own `rationale` property (a Decision today; `cognitive-queries.ts` lets any
   * cognitive type carry one). Named `why` rather than `rationale` on purpose: `rationale` is
   * already the retrieval rationale (method, score, path) on a pack item, and the two would
   * collide under one name from here on.
   */
  readonly why?: string;
  /** Distinct current episodes mentioning the node; absent for a node type `MENTIONS` never targets. */
  readonly mentionCount?: number;
};

export type ScoredSeedCandidate = SeedCandidate & {
  readonly score: number;
};

export type EntityNameMatch = ScoredSeedCandidate & {
  /** The normalized name that matched, so the caller can attribute the hit back to its cue. */
  readonly nameNorm: string;
};

/**
 * The same shape `backbone.ts` writes into `name_norm`. An identity lookup only resolves when
 * both sides normalize identically, and this is key folding on a name, not term derivation:
 * nothing is split, dropped, stemmed, or rewritten.
 */
export function normalizeSeedName(name: string): string {
  return foldName(name);
}

/**
 * Every metacharacter Lucene's query parser reads as syntax. Escaping them is what keeps a
 * cue like `useEffect()` or `--flag` a query instead of a parse error.
 */
const LUCENE_SYNTAX = /([+\-!(){}[\]^"~*?:\\/&|])/g;

/**
 * Syntax safety only. Each metacharacter is escaped so the parser hands the cue to the
 * index analyzer as literal text; no cue is tokenized, stemmed, or reduced to terms here.
 * Bare uppercase `AND`/`OR`/`NOT` stay operators (escaping their letters would not change
 * that), so a cue that trips the parser is caught by the caller and contributes nothing.
 */
export function escapeLuceneQuery(text: string): string {
  return text.trim().replace(LUCENE_SYNTAX, '\\$1');
}

/**
 * The same escaped cue wrapped as a Lucene phrase, so the index answers "does any document
 * contain this cue verbatim" rather than "does any document share a term with it". The
 * analyzer still does the term work; wrapping in quotes only asks Lucene to require the
 * terms it produced, in order and adjacent.
 *
 * That is the only literal-match evidence recall can get from the lexical leg: a plain
 * fulltext hit means one shared term at an uncalibrated score, which is not a measurement
 * anything can be admitted on.
 */
export function lucenePhraseQuery(text: string): string {
  const escaped = escapeLuceneQuery(text);
  if (escaped.length === 0) {
    return '';
  }
  return `"${escaped}"`;
}

function candidateProjection(nodeVar: string, fragment: ReadFragment): string {
  return [
    `${nodeVar}.id AS id`,
    `labels(${nodeVar}) AS labels`,
    `coalesce(${nodeVar}.${MEMORY_PROPERTIES.summary}, ${nodeVar}.${MEMORY_PROPERTIES.text},` +
      ` ${nodeVar}.${ENTITY_NAME_PROPERTY}, '') AS content`,
    `${nodeVar}.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
    `${nodeVar}.${STRUCTURAL_PROPERTY} AS is_structural`,
    `${nodeVar}.${MEMORY_PROPERTIES.sourceEpisodeId} AS source_episode_id`,
    // `rationale` is only ever written by `cognitive-queries.ts`, so this reads `null` for
    // every node type that never carries it; the property name stays `rationale` in the
    // graph, `why` is the wire name that keeps it distinct from a retrieval rationale.
    `${nodeVar}.rationale AS why`,
    // 'MENTIONS' mirrors `entity-mention-queries.ts`'s `ENTITY_MENTION_TYPE`, inlined here to avoid an import cycle back into that module.
    `COUNT { MATCH (ep:Episode)-[:MENTIONS]->(${nodeVar}) WHERE ${currentOnly('ep')} } AS mention_count`,
    fragment.projection,
  ].join(', ');
}

function mapCandidate(row: Row): SeedCandidate {
  const occurredAt = row.occurred_at;
  const sourceEpisodeId = row.source_episode_id;
  const { why } = row;
  const mentionCount = (row.mention_count as number | null) ?? 0;
  return {
    id: row.id as string,
    labels: (row.labels as string[] | null) ?? [],
    content: typeof row.content === 'string' ? row.content : '',
    ...(occurredAt instanceof Date ? { occurredAt } : {}),
    ...(row.is_structural === true ? { isStructural: true } : {}),
    ...(typeof sourceEpisodeId === 'string' ? { sourceEpisodeId } : {}),
    ...(typeof why === 'string' && why.trim().length > 0 ? { why } : {}),
    ...(mentionCount > 0 ? { mentionCount } : {}),
    ...readCurrencyAnnotation(row),
  };
}

function mapScoredCandidate(row: Row): ScoredSeedCandidate {
  return { ...mapCandidate(row), score: row.score as number };
}

export type VectorSeedInput = {
  readonly vector: Vector;
  readonly limit: number;
  readonly mode: ReadMode;
};

/**
 * The read mode filters the index's answer rather than its search: `queryNodes` picks its k
 * nearest before any predicate runs, so a forgotten or out-of-window neighbour still spends
 * one of the k slots. `recall.vectorLimit` is the lever if that ever bites.
 */
export async function vectorSeeds(
  driver: Driver,
  input: VectorSeedInput,
): Promise<ScoredSeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'CALL db.index.vector.queryNodes($index, $limit, $vector) YIELD node AS n, score AS rescaled',
    `WITH n, ${asCosine('rescaled')} AS score WHERE ${fragment.where}`,
    `RETURN ${candidateProjection('n', fragment)}, score`,
    'ORDER BY score DESC',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      index: CONTENT_VECTOR_INDEX,
      limit: toGraphInteger(input.limit),
      vector: toGraphVector(input.vector),
    },
    mapScoredCandidate,
  );
}

/**
 * The same input the content-index leg takes; the difference is which index is searched, not
 * what the caller has to hand it.
 */
export type ContextVectorSeedInput = VectorSeedInput;

/**
 * The second index the vector leg searches: `context_vec_idx`, whose vectors describe a node's
 * neighborhood rather than its own text.
 *
 * Two indexes, one measurement. The search finds candidates by neighborhood, and the score
 * returned is the ordinary query-against-content cosine, so a row from here is admitted, ranked
 * and corroborated on exactly the number a row from the content index carries. Scoring on the
 * context cosine instead would put a second distribution in front of a floor calibrated on the
 * first.
 *
 * The leg exists because the two indexes disagree about rank in a way that matters. Measured on
 * the live substrate for "how did we fix the checkout latency": the nodes stating the fix sit at
 * ranks 1 to 5 in the context index and at 12, 15, 19, 44 and 55 in the content index, all with
 * content cosines at or above the admission floor. They were admissible all along and never
 * became candidates, which is what left the round's "how did we fix" questions answerless.
 *
 * A node with no content vector is skipped rather than scored at zero: it has no measurement to
 * be admitted on, and the traversal leg already carries nodes whose embeddings are pending.
 */
export async function contextVectorSeeds(
  driver: Driver,
  input: ContextVectorSeedInput,
): Promise<ScoredSeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const contentVector = `n.${MEMORY_PROPERTIES.contentVector}`;
  const cypher = [
    'CALL db.index.vector.queryNodes($index, $limit, $vector) YIELD node AS n',
    `WHERE ${contentVector} IS NOT NULL AND size(${contentVector}) = $dimension`,
    `  AND ${fragment.where}`,
    `WITH n, ${asCosine(`vector.similarity.cosine(${contentVector}, $vector)`)} AS score`,
    `RETURN ${candidateProjection('n', fragment)}, score`,
    'ORDER BY score DESC',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      index: CONTEXT_VECTOR_INDEX,
      limit: toGraphInteger(input.limit),
      dimension: toGraphInteger(input.vector.length),
      vector: toGraphVector(input.vector),
    },
    mapScoredCandidate,
  );
}

export type FulltextSeedInput = {
  /** Already escaped for the Lucene parser; passed to the index verbatim. */
  readonly query: string;
  readonly limit: number;
  readonly mode: ReadMode;
};

export async function fulltextSeeds(
  driver: Driver,
  input: FulltextSeedInput,
): Promise<ScoredSeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'CALL db.index.fulltext.queryNodes($index, $query) YIELD node AS n, score',
    `WITH n, score WHERE ${fragment.where}`,
    `RETURN ${candidateProjection('n', fragment)}, score`,
    'ORDER BY score DESC',
    'LIMIT $limit',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      index: CONTENT_FULLTEXT_INDEX,
      query: input.query,
      limit: toGraphInteger(input.limit),
    },
    mapScoredCandidate,
  );
}

export type EntityNameSeedInput = {
  /** Normalized through `normalizeSeedName`; matched against `name_norm` and every alias key. */
  readonly names: readonly string[];
  readonly mode: ReadMode;
};

/**
 * Structural entities are in scope deliberately: the Member and the global Workspace are the
 * backbone every session hangs off, so a cue naming either is a legitimate way into the graph.
 *
 * The alias branch is what keeps an absorbed name admissible. A merge folds "PostgreSQL" into
 * "Postgres" and the surface form survives only in `aliases_norm`; without this branch the cue
 * that used to land an exact match would fall through to the vector leg and be admitted, or
 * not, on a cosine. An alias hit is the same evidence as a name hit (the graph is asserting
 * these are one identity), so it carries the same score, and the matched cue comes back rather
 * than the node's own name, since the cue is what the caller attributes the hit to.
 */
export async function entityNameSeeds(
  driver: Driver,
  input: EntityNameSeedInput,
): Promise<EntityNameMatch[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const aliases = `coalesce(n.${ENTITY_ALIASES_NORM_PROPERTY}, [])`;
  // `name_norm` is constraint-indexed and `aliases_norm` is not, so an `OR` scans every Entity.
  const arm = (where: string): string =>
    `  MATCH (n:Entity) WHERE ${where} AND ${fragment.where}\n  RETURN n`;
  const cypher = [
    `CALL {\n${arm(`n.${ENTITY_NAME_NORM_PROPERTY} IN $names`)}\n  UNION\n` +
      `${arm(`any(alias IN ${aliases} WHERE alias IN $names)`)}\n}`,
    // The identity's own name first, so a node matched both ways attributes to the exact cue.
    `WITH n, [name IN $names WHERE name = n.${ENTITY_NAME_NORM_PROPERTY}] +`,
    `        [name IN $names WHERE name <> n.${ENTITY_NAME_NORM_PROPERTY}` +
      ` AND name IN ${aliases}] AS matched`,
    `RETURN ${candidateProjection('n', fragment)},`,
    '       matched[0] AS name_norm',
  ].join('\n');

  return runRead(driver, cypher, { ...fragment.parameters, names: [...input.names] }, (row) => ({
    ...mapCandidate(row),
    score: EXACT_NAME_MATCH_SCORE,
    nameNorm: row.name_norm as string,
  }));
}

export type EntitySimilaritySeedInput = {
  readonly vector: Vector;
  readonly threshold: number;
  readonly limit: number;
  readonly mode: ReadMode;
};

/**
 * Entity extraction is what writes `name_vec`, so before it has run the `IS NOT NULL`
 * predicate matches nothing and the leg returns empty. That is the same state a cold-start
 * substrate is in, which is why it is shipped behaviour rather than a stub.
 *
 * No index covers `name_vec`: the vector indexes are declared on `content_vec` and
 * `context_vec`, so this scans entities carrying one. The dimension guard is required:
 * `vector.similarity.cosine` errors on mismatched lengths rather than returning null.
 */
export async function entitySimilaritySeeds(
  driver: Driver,
  input: EntitySimilaritySeedInput,
): Promise<ScoredSeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'MATCH (n:Entity)',
    `WHERE n.${ENTITY_NAME_VECTOR_PROPERTY} IS NOT NULL`,
    `  AND size(n.${ENTITY_NAME_VECTOR_PROPERTY}) = $dimension`,
    `  AND ${fragment.where}`,
    `WITH n, ${asCosine(`vector.similarity.cosine(n.${ENTITY_NAME_VECTOR_PROPERTY}, $vector)`)} AS score`,
    'WHERE score >= $threshold',
    `RETURN ${candidateProjection('n', fragment)}, score`,
    'ORDER BY score DESC',
    'LIMIT $limit',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      vector: toGraphVector(input.vector),
      dimension: toGraphInteger(input.vector.length),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    mapScoredCandidate,
  );
}

export type NodesByIdInput = {
  readonly ids: readonly string[];
  readonly mode: ReadMode;
};

/**
 * Spreading activation returns node ids and nothing else, so an activated node reaches the
 * pack through this. The read mode is spliced in a second time rather than inherited from
 * the traversal: currency is re-judged on the row that actually reaches the agent, and a
 * node forgotten between the two reads is suppressed here.
 */
export async function nodeCandidates(
  driver: Driver,
  input: NodesByIdInput,
): Promise<SeedCandidate[]> {
  if (input.ids.length === 0) {
    return [];
  }
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${fragment.where}`,
    `RETURN ${candidateProjection('n', fragment)}`,
  ].join('\n');

  return runRead(
    driver,
    cypher,
    { ...fragment.parameters, ids: [...new Set(input.ids)] },
    mapCandidate,
  );
}

export type NodeContentVector = {
  readonly id: string;
  readonly vector: number[];
};

/**
 * Content embeddings for a set of ids, batched: a full embedding per row is the reason recall
 * asks for vectors where it needs them instead of carrying them through the ordinary path. Two
 * callers need them, the MMR reranker over the ranked set and arrival scoring over what the
 * spread reached. A row comes back only for a node that carries a vector, so an id missing
 * from the answer is a pending embedding rather than a zero.
 */
export async function contentVectors(
  driver: Driver,
  input: NodesByIdInput,
): Promise<NodeContentVector[]> {
  if (input.ids.length === 0) {
    return [];
  }
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL AND ${fragment.where}`,
    `RETURN n.id AS id, n.${MEMORY_PROPERTIES.contentVector} AS vector`,
  ].join('\n');

  return runRead(
    driver,
    cypher,
    { ...fragment.parameters, ids: [...new Set(input.ids)] },
    (row) => ({
      id: row.id as string,
      vector: fromGraphVector(row.vector) ?? [],
    }),
  );
}

export type RecencySeedInput = {
  readonly limit: number;
  readonly mode: ReadMode;
};

/**
 * Rows come back newest-first and unscored; the caller turns position into a score, because
 * recency is an ordering, not a measurement.
 *
 * Two-tier ordering rather than a coalesce: nodes that have actually been recalled outrank
 * nodes that are merely new. On a substrate that has served no recalls nothing carries
 * `last_accessed`, the first tier is empty, and the whole ordering degrades to `tx_from`
 * DESC. Ranking policy, not text machinery: both tiers answer "recently relevant".
 *
 * No index covers either ordering key, so this sorts a `:Memory` scan. Bounded by `LIMIT` and
 * by a single-user graph; it is the one seed strategy whose cost grows with total memory.
 */
export async function recencySeeds(
  driver: Driver,
  input: RecencySeedInput,
): Promise<SeedCandidate[]> {
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    `MATCH (n:${MEMORY_LABEL})`,
    `WHERE ${fragment.where}`,
    'WITH n',
    `ORDER BY CASE WHEN n.${LAST_ACCESSED_PROPERTY} IS NULL THEN 1 ELSE 0 END,`,
    `         n.${LAST_ACCESSED_PROPERTY} DESC,`,
    `         n.${BITEMPORAL_PROPERTIES.txFrom} DESC`,
    'LIMIT $limit',
    `RETURN ${candidateProjection('n', fragment)}`,
  ].join('\n');

  return runRead(
    driver,
    cypher,
    { ...fragment.parameters, limit: toGraphInteger(input.limit) },
    mapCandidate,
  );
}

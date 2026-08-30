import { randomUUID } from 'node:crypto';
import neo4j, { type Driver } from 'neo4j-driver';
import { runRead } from './connection.js';
import { upsertEdge } from './edges.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import { CONTENT_VECTOR_INDEX, type NodeContentVector } from './seed-queries.js';
import { toGraphVector } from './values.js';

/**
 * Co-occurrence and semantic association edges between entities. Both flow through
 * `edges.ts`'s merge policy, so this module only ever builds one `EdgeUpsert` per
 * call; the accumulation, the endpoint normalization, and the signal/provenance union all
 * live there already.
 *
 * The two association types differ in what "the same fact again" means. Co-occurrence is an
 * episodic observation: the count accumulates per shared episode, so the caller (the stage)
 * gates each pair through an SQLite ledger key before calling `linkCoOccurrence`, the same
 * way the pipeline's own `reflection:orchestrator:{episodeId}` key gates the whole run.
 * Semantic similarity is a standing fact about two entities' embeddings, true independent of
 * which episode triggered the check, so `linkSimilarity` carries `count: 0` and needs no such
 * gate: MERGE alone makes a repeat call a no-op.
 */

export const CO_OCCURS_TYPE: RelationshipType = 'CO_OCCURS';
export const SIMILAR_TYPE: RelationshipType = 'SIMILAR';

const ASSOCIATION_PROVENANCE = ['reflection'];
const CO_OCCURRENCE_RATIONALE = 'both entities were mentioned in the same episode';
const SEMANTIC_SIMILARITY_RATIONALE = 'entity content vectors are semantically similar';

export type LinkCoOccurrenceInput = {
  readonly sourceId: string;
  readonly targetId: string;
  /**
   * What this single co-occurrence is worth, already discounted by the caller for how many
   * entities the episode named. It is a step, not a target: see `edges.ts`'s `bounded_step`.
   */
  readonly observationStrength: number;
  /** The strength a co-occurrence edge may not be written below, `hebbian.weightFloor`. */
  readonly weightFloor: number;
  readonly now: Date;
};

/**
 * One pair, already ledger-gated by the caller. `count: 1` is the one observation this call
 * stands for, and the strength moves one bounded step rather than pinning at 1.
 *
 * Pinning was the bug this replaces. Every pair of an episode's all-pairs clique was written
 * at full strength, so an episode naming twenty entities produced 190 edges each asserting as
 * much as the single edge of an episode naming two, plasticity's bounded rule had no room to
 * move any of them (`w + eta * (1 - w)` is `w` at `w = 1`), and a later co-occurrence between
 * a decayed pair snapped it back to 1.0 in one write, erasing however much disuse had taken
 * off it. A step from the current weight is all three problems at once: the discount lands,
 * repeated co-occurrence still accumulates, and decay is not undone by a single observation.
 */
export async function linkCoOccurrence(driver: Driver, input: LinkCoOccurrenceInput): Promise<void> {
  await upsertEdge(driver, {
    type: CO_OCCURS_TYPE,
    sourceId: input.sourceId,
    targetId: input.targetId,
    strength: input.observationStrength,
    strengthPolicy: 'bounded_step',
    weightFloor: input.weightFloor,
    confidence: 1,
    signals: ['episodic'],
    provenance: ASSOCIATION_PROVENANCE,
    rationale: CO_OCCURRENCE_RATIONALE,
    count: 1,
    now: input.now,
  });
}

export type LinkSimilarityInput = {
  readonly sourceId: string;
  readonly targetId: string;
  /** Cosine similarity, already past the caller's threshold; carried as the edge's strength. */
  readonly score: number;
  readonly now: Date;
};

export type LinkSimilarityResult = {
  /** False when the edge already existed: the same pair surfaced again, by this run or an earlier one. */
  readonly created: boolean;
};

/**
 * A proposed id travels with the call so `created` can be read the same way entity and
 * cognitive-node writes read it: the id survives in the row only when this call is the one
 * that made the node (here, the edge).
 */
export async function linkSimilarity(
  driver: Driver,
  input: LinkSimilarityInput,
): Promise<LinkSimilarityResult> {
  const id = randomUUID();
  const edge = await upsertEdge(driver, {
    type: SIMILAR_TYPE,
    id,
    sourceId: input.sourceId,
    targetId: input.targetId,
    strength: input.score,
    confidence: 1,
    signals: ['semantic'],
    provenance: ASSOCIATION_PROVENANCE,
    rationale: SEMANTIC_SIMILARITY_RATIONALE,
    count: 0,
    now: input.now,
  });
  return { created: edge.id === id };
}

export type SimilarEntityCandidate = {
  readonly sourceId: string;
  readonly targetId: string;
  readonly score: number;
};

export type FindSimilarEntityCandidatesInput = {
  /** One entity per seed: its id and its content vector, e.g. from `contentVectors`. */
  readonly entities: readonly NodeContentVector[];
  readonly threshold: number;
  /** Per-entity cap on how many candidates come back, applied after the threshold and the label filter. */
  readonly limit: number;
  readonly mode: ReadMode;
};

/**
 * `content_vec_idx` spans every `:Memory` label, not just `Entity`, so the index is asked for
 * more neighbours than the per-entity limit before the `Entity` filter and the threshold
 * narrow it down: otherwise a seed whose nearest neighbours in the raw index are mostly
 * episodes or turns would come back with too few (or zero) entity candidates.
 */
const KNN_OVERSAMPLE_FACTOR = 5;

/** Procedure arguments and list-slice bounds are Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

/**
 * The semantic leg of association-building, batched across every entity the caller passes in
 * one round trip: `UNWIND` the seeds, query the vector index once per seed, group back down
 * to the seed's own top matches. Neo4j's index reports cosine rescaled onto [0,1] the same way
 * `seed-queries.ts` documents; it is converted back to a true cosine here so `threshold`
 * compares like against like.
 */
export async function findSimilarEntityCandidates(
  driver: Driver,
  input: FindSimilarEntityCandidatesInput,
): Promise<SimilarEntityCandidate[]> {
  if (input.entities.length === 0) {
    return [];
  }
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    'UNWIND $seeds AS seed',
    'CALL db.index.vector.queryNodes($index, $k, seed.vector) YIELD node AS n, score AS rescaled',
    'WITH seed, n, (2.0 * rescaled - 1.0) AS score',
    `WHERE n:Entity AND n.id <> seed.id AND score >= $threshold AND ${fragment.where}`,
    'WITH seed, n, score ORDER BY seed.id, score DESC',
    'WITH seed.id AS sourceId, collect({ id: n.id, score: score })[0..$limit] AS matches',
    'UNWIND matches AS match',
    'RETURN sourceId, match.id AS targetId, match.score AS score',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      ...fragment.parameters,
      seeds: input.entities.map((entity) => ({ id: entity.id, vector: toGraphVector(entity.vector) })),
      index: CONTENT_VECTOR_INDEX,
      k: toGraphInteger(input.limit * KNN_OVERSAMPLE_FACTOR),
      threshold: input.threshold,
      limit: toGraphInteger(input.limit),
    },
    (row) => ({
      sourceId: row.sourceId as string,
      targetId: row.targetId as string,
      score: row.score as number,
    }),
  );
}

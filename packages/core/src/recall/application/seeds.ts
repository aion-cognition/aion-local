import type { CueSource, CueWeight, RecallMethod } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import { withCurrency, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import {
  entityNameSeeds,
  entitySimilaritySeeds,
  escapeLuceneQuery,
  fulltextSeeds,
  normalizeSeedName,
  recencySeeds,
  vectorSeeds,
  type ScoredSeedCandidate,
  type SeedCandidate,
} from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';

/**
 * Whitepaper §5.2: four strategies run together, their candidates merge, and each surviving
 * seed keeps every strategy that found it. The strategies themselves are Cypher and live in
 * `graph/seed-queries.ts`; this file is scoring, merging, and the order they run in.
 */

/** Also `RecallMethod` values, so fusion carries a provenance entry into an item rationale unchanged. */
export const SEED_STRATEGIES = [
  'vector',
  'bm25',
  'entity_resolution',
  'recency',
] as const satisfies readonly RecallMethod[];

export type SeedStrategy = (typeof SEED_STRATEGIES)[number];

/** Whitepaper Algorithm 1's top bucket. Every cue-driven score is expressed as a fraction of it. */
const MAX_CUE_WEIGHT = 3;

export type SeedCue = {
  readonly text: string;
  readonly source: CueSource;
  readonly weight: CueWeight;
  /**
   * Embedded by the caller, never here: recall's generation budget is spent once on cue
   * extraction (PRD §10), and the embedding pass belongs with it. A cue that arrives without
   * a vector still drives BM25 and exact entity resolution.
   */
  readonly vector?: Vector;
};

/**
 * Two numbers, because Algorithm 1's bucket weights and the relevance floor answer different
 * questions. `score` is the ranking number: the method's score scaled by the weight of the cue
 * that found it, which is how a query cue outranks a recent-turn cue. `relevance` is the
 * method's own measurement on its own comparable scale, which is what `AION_MIN_RELEVANCE`
 * is measured against.
 *
 * Composing the two — measuring a weighted score against an absolute floor — deletes whole
 * buckets: at the pinned floor of 0.35 no 1x recent-turn cue could ever contribute an item,
 * however perfect its match, because 1.0 scaled to a third of itself is 0.333.
 */
export type SeedProvenance = {
  readonly strategy: SeedStrategy;
  readonly score: number;
  readonly relevance: number;
  /** The cue text behind the hit; absent for recency, which no cue drives. */
  readonly cue?: string;
};

export type Seed = SeedCandidate & {
  /** The best of `provenance`, which is ordered to match. */
  readonly score: number;
  /** The strongest measurement any strategy made of this node, unscaled. */
  readonly relevance: number;
  readonly provenance: readonly SeedProvenance[];
};

export type SeedContribution = {
  readonly candidate: SeedCandidate;
  readonly strategy: SeedStrategy;
  readonly score: number;
  readonly relevance: number;
  readonly cue?: string;
};

export type SeedSelection = {
  /** Merged, deduped, and cut to `contextResonance.seedLimit`. What activation starts from. */
  readonly seeds: readonly Seed[];
  /**
   * Every query the selection issued was rejected, which is the graph being gone rather
   * than a query nothing matched. Per-leg isolation cannot tell the two apart on its own,
   * and a caller that cannot tell either reads a total outage as an empty substrate.
   */
  readonly graphUnavailable: boolean;
  /**
   * Each strategy's own candidates, deduped and ranked but not cut, because RRF fuses ranked
   * lists and the top-k merge discards the ranks below the cut.
   */
  readonly byStrategy: Readonly<Record<SeedStrategy, readonly Seed[]>>;
};

export type SelectSeedsDeps = {
  readonly driver: Driver;
  readonly config: Config;
  readonly logger: Logger;
};

export type SelectSeedsInput = {
  readonly cues: readonly SeedCue[];
  /** Defaults to `withCurrency()`; the pipeline passes `asOf`/`knewAt` straight through. */
  readonly mode?: ReadMode;
};

export function scaleByCueWeight(score: number, weight: CueWeight): number {
  return score * (weight / MAX_CUE_WEIGHT);
}

/**
 * A Lucene score has no fixed range — it moves with the corpus and the query — so a raw BM25
 * number is not comparable with a cosine similarity in the merge. Dividing by the best hit for
 * the same cue puts the leg on (0, 1] and leaves its internal ranking untouched. Vector and
 * entity scores are left alone; those are already cosine similarities.
 */
export function normalizeToBest(
  rows: readonly ScoredSeedCandidate[],
): readonly ScoredSeedCandidate[] {
  let best = 0;
  for (const row of rows) {
    if (row.score > best) {
      best = row.score;
    }
  }
  if (best <= 0) {
    return rows;
  }
  return rows.map((row) => ({ ...row, score: row.score / best }));
}

/**
 * Reciprocal rank, so the bias stays a bias: the most recently touched node competes with a
 * strong content hit and the tail falls away fast, rather than a flat recency list crowding
 * out everything the cues found.
 *
 * A rank, never a relevance. Whitepaper §5.2 calls recency a weighting of the seed selection,
 * and "this was touched recently" is not a measurement of how well a node answers the query,
 * so a recency contribution carries `relevance: 0` (`RECENCY_RELEVANCE`). It seeds the spread
 * and it corroborates a node another strategy also found; on its own it never fills a pack.
 */
export function recencyScore(rank: number): number {
  return 1 / (1 + rank);
}

export const RECENCY_RELEVANCE = 0;

function compareProvenance(a: SeedProvenance, b: SeedProvenance): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.strategy.localeCompare(b.strategy);
}

/** Best score wins; corroboration by more strategies breaks a tie, then id for a stable order. */
function compareSeeds(a: Seed, b: Seed): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.provenance.length !== b.provenance.length) {
    return b.provenance.length - a.provenance.length;
  }
  return a.id.localeCompare(b.id);
}

function toProvenance(contribution: SeedContribution): SeedProvenance {
  const base = {
    strategy: contribution.strategy,
    score: contribution.score,
    relevance: contribution.relevance,
  };
  if (contribution.cue === undefined) {
    return base;
  }
  return { ...base, cue: contribution.cue };
}

/**
 * Dedupe is by node id across every strategy, and a node found several ways keeps all of it:
 * the provenance list is what lets fusion explain the item and what makes corroboration
 * visible instead of collapsed into one number.
 */
export function mergeSeeds(
  contributions: readonly SeedContribution[],
  limit: number,
): readonly Seed[] {
  const merged = new Map<string, { candidate: SeedCandidate; provenance: SeedProvenance[] }>();

  for (const contribution of contributions) {
    const entry = merged.get(contribution.candidate.id);
    if (entry === undefined) {
      merged.set(contribution.candidate.id, {
        candidate: contribution.candidate,
        provenance: [toProvenance(contribution)],
      });
      continue;
    }
    entry.provenance.push(toProvenance(contribution));
  }

  const seeds: Seed[] = [];
  for (const { candidate, provenance } of merged.values()) {
    provenance.sort(compareProvenance);
    const best = provenance[0];
    let relevance = 0;
    for (const entry of provenance) {
      relevance = Math.max(relevance, entry.relevance);
    }
    // Absent optionals stay absent rather than becoming explicit `undefined` keys, so a pack
    // item built by spreading a seed carries only the fields the seed actually has.
    seeds.push({
      id: candidate.id,
      labels: candidate.labels,
      content: candidate.content,
      ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
      ...(candidate.isStructural === undefined ? {} : { isStructural: candidate.isStructural }),
      ...(candidate.sourceEpisodeId === undefined
        ? {}
        : { sourceEpisodeId: candidate.sourceEpisodeId }),
      currency: candidate.currency,
      ...(candidate.supersededBy === undefined ? {} : { supersededBy: candidate.supersededBy }),
      score: best === undefined ? 0 : best.score,
      relevance,
      provenance,
    });
  }

  seeds.sort(compareSeeds);
  return seeds.slice(0, Math.max(0, limit));
}

function contribute(
  strategy: SeedStrategy,
  candidate: ScoredSeedCandidate,
  cue: SeedCue | undefined,
): SeedContribution {
  if (cue === undefined) {
    return { candidate, strategy, score: candidate.score, relevance: candidate.score };
  }
  return {
    candidate,
    strategy,
    score: scaleByCueWeight(candidate.score, cue.weight),
    relevance: candidate.score,
    cue: cue.text,
  };
}

function embeddedCues(cues: readonly SeedCue[]): ReadonlyArray<SeedCue & { vector: Vector }> {
  const embedded: Array<SeedCue & { vector: Vector }> = [];
  for (const cue of cues) {
    const vector = cue.vector;
    if (vector !== undefined && vector.length > 0) {
      embedded.push({ ...cue, vector });
    }
  }
  return embedded;
}

/** What a leg produced, plus how many of its queries were issued and how many were rejected. */
type SettledLeg = {
  readonly contributions: SeedContribution[];
  readonly attempted: number;
  readonly failed: number;
};

/**
 * A query that fails contributes nothing rather than failing recall; degradation is less
 * evidence. Only a rejection is logged — a leg that legitimately finds nothing, which is
 * every entity-similarity call until entity name embeddings exist, is silent.
 *
 * The counts are what keeps the isolation from lying: one rejected query is a leg down,
 * every rejected query is the graph down, and only the caller sees both numbers.
 */
async function settle(
  logger: Logger,
  strategy: SeedStrategy,
  detail: string,
  tasks: ReadonlyArray<Promise<readonly SeedContribution[]>>,
): Promise<SettledLeg> {
  const settled = await Promise.allSettled(tasks);
  const contributions: SeedContribution[] = [];
  let failed = 0;
  for (const result of settled) {
    if (result.status === 'rejected') {
      failed += 1;
      logger.warn({ strategy, detail, err: result.reason }, 'seed query failed');
      continue;
    }
    contributions.push(...result.value);
  }
  return { contributions, attempted: settled.length, failed };
}

async function vectorContributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
): Promise<SettledLeg> {
  const tasks = embeddedCues(cues).map(async (cue) => {
    const rows = await vectorSeeds(deps.driver, {
      vector: cue.vector,
      limit: deps.config.recall.vectorLimit,
      mode,
    });
    return rows.map((row) => contribute('vector', row, cue));
  });
  return settle(deps.logger, 'vector', 'cue vector search', tasks);
}

/**
 * Per-cue rather than one combined query, so one cue that trips the Lucene parser costs only
 * its own contribution. The cue text reaches the index escaped but otherwise verbatim.
 */
async function bm25Contributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
): Promise<SettledLeg> {
  const tasks: Array<Promise<readonly SeedContribution[]>> = [];
  for (const cue of cues) {
    const query = escapeLuceneQuery(cue.text);
    if (query.length === 0) {
      continue;
    }
    tasks.push(
      (async () => {
        const rows = await fulltextSeeds(deps.driver, {
          query,
          limit: deps.config.recall.vectorLimit,
          mode,
        });
        return normalizeToBest(rows).map((row) => contribute('bm25', row, cue));
      })(),
    );
  }
  return settle(deps.logger, 'bm25', 'cue fulltext search', tasks);
}

/**
 * Identity first, similarity second. One name can be carried by several cues; the heaviest
 * one owns the hit, since the weight is what the match is scaled by.
 *
 * The fuzzy leg is a per-cue KNN like the vector leg, so it takes the same per-cue cap
 * (`recall.vectorLimit`) and its own threshold (`recall.entityMatchThreshold`). Neither is
 * `contextResonance.*`: that group is Algorithm 3's, and one knob cannot mean both "how close
 * two names have to be to be the same entity" and "how close two context vectors have to be
 * to resonate" without silently retuning one while tuning the other.
 */
async function entityContributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
): Promise<SettledLeg> {
  const byName = new Map<string, SeedCue>();
  for (const cue of cues) {
    const name = normalizeSeedName(cue.text);
    if (name.length === 0) {
      continue;
    }
    const held = byName.get(name);
    if (held === undefined || cue.weight > held.weight) {
      byName.set(name, cue);
    }
  }

  const tasks: Array<Promise<readonly SeedContribution[]>> = [];
  if (byName.size > 0) {
    tasks.push(
      (async () => {
        const rows = await entityNameSeeds(deps.driver, { names: [...byName.keys()], mode });
        return rows.map((row) => contribute('entity_resolution', row, byName.get(row.nameNorm)));
      })(),
    );
  }

  for (const cue of embeddedCues(cues)) {
    tasks.push(
      (async () => {
        const rows = await entitySimilaritySeeds(deps.driver, {
          vector: cue.vector,
          threshold: deps.config.recall.entityMatchThreshold,
          limit: deps.config.recall.vectorLimit,
          mode,
        });
        return rows.map((row) => contribute('entity_resolution', row, cue));
      })(),
    );
  }

  return settle(deps.logger, 'entity_resolution', 'entity resolution', tasks);
}

async function recencyContributions(
  deps: SelectSeedsDeps,
  mode: ReadMode,
): Promise<SettledLeg> {
  const task = (async () => {
    const rows = await recencySeeds(deps.driver, {
      limit: deps.config.contextResonance.seedLimit,
      mode,
    });
    return rows.map((row, rank) => ({
      candidate: row,
      strategy: 'recency' as const,
      score: recencyScore(rank),
      relevance: RECENCY_RELEVANCE,
    }));
  })();
  return settle(deps.logger, 'recency', 'recently accessed nodes', [task]);
}

function emptyByStrategy(): Record<SeedStrategy, readonly Seed[]> {
  return { vector: [], bm25: [], entity_resolution: [], recency: [] };
}

/**
 * All four strategies run together; each one's failure is isolated to itself. The top-k cut is
 * `contextResonance.seedLimit`, which is the whitepaper's seed budget and the only place the
 * candidate set is narrowed.
 *
 * Isolation is per leg, so the all-legs-failed case is counted rather than inferred from an
 * empty result: the recency leg always issues one query, which makes "nothing was attempted"
 * and "everything was rejected" different states.
 */
export async function selectSeeds(
  deps: SelectSeedsDeps,
  input: SelectSeedsInput,
): Promise<SeedSelection> {
  const mode = input.mode ?? withCurrency();
  const cues = input.cues.filter((cue) => cue.text.trim().length > 0);

  const [vector, bm25, entity, recency] = await Promise.all([
    vectorContributions(deps, cues, mode),
    bm25Contributions(deps, cues, mode),
    entityContributions(deps, cues, mode),
    recencyContributions(deps, mode),
  ]);

  const byStrategy = emptyByStrategy();
  const contributions: SeedContribution[] = [];
  let attempted = 0;
  let failed = 0;
  for (const [strategy, leg] of [
    ['vector', vector],
    ['bm25', bm25],
    ['entity_resolution', entity],
    ['recency', recency],
  ] as ReadonlyArray<[SeedStrategy, SettledLeg]>) {
    byStrategy[strategy] = mergeSeeds(leg.contributions, leg.contributions.length);
    contributions.push(...leg.contributions);
    attempted += leg.attempted;
    failed += leg.failed;
  }

  const graphUnavailable = attempted > 0 && failed === attempted;
  if (graphUnavailable) {
    deps.logger.error({ attempted }, 'every seed query failed; treating the graph as unavailable');
  }

  return {
    seeds: mergeSeeds(contributions, deps.config.contextResonance.seedLimit),
    graphUnavailable,
    byStrategy,
  };
}

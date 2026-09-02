import type { CueSource, CueWeight } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import type { Config } from '../../infrastructure/config/schema.js';
import { withCurrency, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import {
  contextVectorSeeds,
  entityNameSeeds,
  entitySimilaritySeeds,
  escapeLuceneQuery,
  fulltextSeeds,
  lucenePhraseQuery,
  memoryPopulation,
  normalizeSeedName,
  recencySeeds,
  vectorSeeds,
  type ScoredSeedCandidate,
} from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Vector } from '../../infrastructure/providers/types.js';
import {
  RECENCY_RELEVANCE,
  legReservations,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  seedBudget,
  selectWithReservations,
  type Seed,
  type SeedBudgetCurve,
  type SeedContribution,
  type SeedStrategy,
} from '../domain/seed-selection.js';

/**
 * Four strategies run together, their candidates merge, and each surviving seed keeps every
 * strategy that found it. The strategies themselves are Cypher and live in
 * `graph/seed-queries.ts`, the merge and the budget arithmetic in `domain/seed-selection.ts`;
 * this file is the order they run in and the sizes they run at.
 */

export {
  SEED_STRATEGIES,
  SEED_STRATEGY_METHODS,
  RECENCY_RELEVANCE,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
} from '../domain/seed-selection.js';
export type {
  Seed,
  SeedBudgetCurve,
  SeedContribution,
  SeedProvenance,
  SeedStrategy,
} from '../domain/seed-selection.js';

export type SeedCue = {
  readonly text: string;
  readonly source: CueSource;
  readonly weight: CueWeight;
  /**
   * Embedded by the caller, never here: recall's generation budget is spent once on cue
   * extraction, and the embedding pass belongs with it. A cue that arrives without a vector
   * still drives BM25 and exact entity resolution.
   */
  readonly vector?: Vector;
};

export type SeedSelection = {
  /** Merged, deduped, and cut to the seed budget. What activation starts from. */
  readonly seeds: readonly Seed[];
  /** The budget this run computed from the substrate's size, for a caller that reports it. */
  readonly budget: number;
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

function budgetCurve(config: Config): SeedBudgetCurve {
  return {
    base: config.contextResonance.seedBudgetBase,
    growth: config.contextResonance.seedBudgetGrowth,
    cap: config.contextResonance.seedLimit,
  };
}

/**
 * The substrate's size, or the base budget when it cannot be read. A count that fails is a
 * reason to seed conservatively, never a reason to fail a recall, and the base is the budget
 * a graph with nothing in it would get anyway.
 */
async function budgetFor(deps: SelectSeedsDeps): Promise<number> {
  const curve = budgetCurve(deps.config);
  try {
    return seedBudget(await memoryPopulation(deps.driver), curve);
  } catch (err) {
    deps.logger.warn({ err }, 'memory population count failed; seeding at the base budget');
    return seedBudget(0, curve);
  }
}

/**
 * How many rows each leg asks for. A per-cue fetch smaller than the leg's reserved slots
 * cannot fill them, and the cue that names the subject is usually one cue rather than all of
 * them, so every leg asks for at least as many rows as it is allowed to keep. The recency leg
 * is one query rather than one per cue, so it reads the whole budget.
 */
function legLimits(config: Config, budget: number): Readonly<Record<SeedStrategy, number>> {
  const reservations = legReservations(budget);
  return {
    vector: Math.max(config.recall.vectorLimit, reservations.vector),
    context_vector: Math.max(config.recall.vectorLimit, reservations.context_vector),
    bm25: Math.max(config.recall.vectorLimit, reservations.bm25),
    entity_resolution: Math.max(config.recall.vectorLimit, reservations.entity_resolution),
    recency: budget,
  };
}

function contribute(
  strategy: SeedStrategy,
  candidate: ScoredSeedCandidate,
  cue: SeedCue | undefined,
  exact?: true,
): SeedContribution {
  const base = {
    candidate,
    strategy,
    relevance: candidate.score,
    ...(exact === undefined ? {} : { exact }),
  };
  if (cue === undefined) {
    return { ...base, score: candidate.score };
  }
  return { ...base, score: scaleByCueWeight(candidate.score, cue.weight), cue: cue.text };
}

function embeddedCues(cues: readonly SeedCue[]): readonly (SeedCue & { vector: Vector })[] {
  const embedded: (SeedCue & { vector: Vector })[] = [];
  for (const cue of cues) {
    const { vector } = cue;
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
 * evidence. Only a rejection is logged: a leg that legitimately finds nothing, which is every
 * entity-similarity call until entity name embeddings exist, is silent.
 *
 * The counts are what keeps the isolation from lying: one rejected query is a leg down,
 * every rejected query is the graph down, and only the caller sees both numbers.
 */
async function settle(
  logger: Logger,
  strategy: SeedStrategy,
  detail: string,
  tasks: readonly Promise<readonly SeedContribution[]>[],
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
  limit: number,
): Promise<SettledLeg> {
  const tasks = embeddedCues(cues).map(async (cue) => {
    const rows = await vectorSeeds(deps.driver, { vector: cue.vector, limit, mode });
    return rows.map((row) => contribute('vector', row, cue));
  });
  return settle(deps.logger, 'vector', 'cue vector search', tasks);
}

/**
 * The same measurement over the other index. It is its own leg rather than extra rows on the
 * one above because the two are reserved from each other: both rank on the query-against-content
 * cosine, so a node the content index buried is buried again in a merged list, and the whole
 * point of asking the context index is to reach the nodes the content index ranks badly.
 */
async function contextVectorContributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
  limit: number,
): Promise<SettledLeg> {
  const tasks = embeddedCues(cues).map(async (cue) => {
    const rows = await contextVectorSeeds(deps.driver, { vector: cue.vector, limit, mode });
    return rows.map((row) => contribute('context_vector', row, cue));
  });
  return settle(deps.logger, 'context_vector', 'cue context vector search', tasks);
}

/**
 * One entry per distinct word, first occurrence's casing kept, order preserved. Lucene's
 * default parser ORs space-separated terms and sums each clause's own score, so a cue that
 * names a word twice would otherwise count that word's match twice over; the phrase query
 * below skips this, since a repeated word is part of what makes the phrase the phrase.
 */
function dedupeQueryTerms(text: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of text.split(/\s+/)) {
    if (term.length === 0) {
      continue;
    }
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms.join(' ');
}

/**
 * Two queries per cue, because the leg answers two different questions. The loose query is
 * the ranked list RRF fuses; the phrase query is the only admission evidence BM25 can offer,
 * since normalizing a corpus-relative Lucene score to the best hit of the same cue puts the
 * top of every list at 1.00 whatever it matched. The phrase leg runs separately rather than
 * being read off the loose one: an exact hit ranked below the leg's own limit there is never
 * seen.
 *
 * Per-cue rather than one combined query, so one cue that trips the Lucene parser costs only
 * its own contribution. The cue text reaches the index escaped and deduped for the loose
 * query, escaped and otherwise verbatim for the phrase query.
 */
async function bm25Contributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
  limit: number,
): Promise<SettledLeg> {
  const tasks: Promise<readonly SeedContribution[]>[] = [];
  for (const cue of cues) {
    const query = escapeLuceneQuery(dedupeQueryTerms(cue.text));
    if (query.length === 0) {
      continue;
    }
    tasks.push(
      (async () => {
        const rows = await fulltextSeeds(deps.driver, { query, limit, mode });
        return normalizeToBest(rows).map((row) => contribute('bm25', row, cue));
      })(),
    );
    tasks.push(
      (async () => {
        const rows = await fulltextSeeds(deps.driver, {
          query: lucenePhraseQuery(cue.text),
          limit,
          mode,
        });
        return normalizeToBest(rows).map((row) => contribute('bm25', row, cue, true));
      })(),
    );
  }
  return settle(deps.logger, 'bm25', 'cue fulltext search', tasks);
}

/**
 * Identity first, similarity second. One name can be carried by several cues; the heaviest
 * one owns the hit, since the weight is what the match is scaled by.
 *
 * The fuzzy leg is a per-cue KNN like the vector leg, so it takes the same per-cue limit and
 * its own threshold (`recall.entityMatchThreshold`). The threshold is not
 * `contextResonance.*`: that group belongs to context resonance, and one knob cannot mean both
 * "how close two names have to be to be the same entity" and "how close two context vectors
 * have to be to resonate" without silently retuning one while tuning the other.
 */
async function entityContributions(
  deps: SelectSeedsDeps,
  cues: readonly SeedCue[],
  mode: ReadMode,
  limit: number,
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

  const tasks: Promise<readonly SeedContribution[]>[] = [];
  if (byName.size > 0) {
    tasks.push(
      (async () => {
        const rows = await entityNameSeeds(deps.driver, { names: [...byName.keys()], mode });
        return rows.map((row) =>
          contribute('entity_resolution', row, byName.get(row.nameNorm), true),
        );
      })(),
    );
  }

  for (const cue of embeddedCues(cues)) {
    tasks.push(
      (async () => {
        const rows = await entitySimilaritySeeds(deps.driver, {
          vector: cue.vector,
          threshold: deps.config.recall.entityMatchThreshold,
          limit,
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
  limit: number,
): Promise<SettledLeg> {
  const task = (async () => {
    const rows = await recencySeeds(deps.driver, { limit, mode });
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
  return { vector: [], context_vector: [], bm25: [], entity_resolution: [], recency: [] };
}

/**
 * All four strategies run together; each one's failure is isolated to itself. The seed budget
 * is the only place the candidate set is narrowed, and it is sized from the substrate before
 * the legs run, because a leg that fetches fewer rows than its reservation cannot fill it.
 *
 * Isolation is per leg, so the all-legs-failed case is counted rather than inferred from an
 * empty result: the recency leg always issues one query, which makes "nothing was attempted"
 * and "everything was rejected" different states. The population count sits outside that
 * tally: it reads no candidates, so a failure there is a smaller budget rather than a leg down.
 */
export async function selectSeeds(
  deps: SelectSeedsDeps,
  input: SelectSeedsInput,
): Promise<SeedSelection> {
  const mode = input.mode ?? withCurrency();
  const cues = input.cues.filter((cue) => cue.text.trim().length > 0);
  const budget = await budgetFor(deps);
  const limits = legLimits(deps.config, budget);

  const [vector, contextVector, bm25, entity, recency] = await Promise.all([
    vectorContributions(deps, cues, mode, limits.vector),
    contextVectorContributions(deps, cues, mode, limits.context_vector),
    bm25Contributions(deps, cues, mode, limits.bm25),
    entityContributions(deps, cues, mode, limits.entity_resolution),
    recencyContributions(deps, mode, limits.recency),
  ]);

  const byStrategy = emptyByStrategy();
  const contributions: SeedContribution[] = [];
  let attempted = 0;
  let failed = 0;
  for (const [strategy, leg] of [
    ['vector', vector],
    ['context_vector', contextVector],
    ['bm25', bm25],
    ['entity_resolution', entity],
    ['recency', recency],
  ] as readonly [SeedStrategy, SettledLeg][]) {
    byStrategy[strategy] = mergeSeeds(leg.contributions, leg.contributions.length);
    contributions.push(...leg.contributions);
    attempted += leg.attempted;
    failed += leg.failed;
  }

  // The fusion list for the vector method is both indexes together, because both measured the
  // same thing and RRF ranks one list per method. The per-strategy lists above stay split:
  // that split is what the reservations are drawn from.
  byStrategy.vector = mergeSeeds(
    [...vector.contributions, ...contextVector.contributions],
    vector.contributions.length + contextVector.contributions.length,
  );

  const graphUnavailable = attempted > 0 && failed === attempted;
  if (graphUnavailable) {
    deps.logger.error({ attempted }, 'every seed query failed; treating the graph as unavailable');
  }

  return {
    seeds: selectWithReservations({
      ranked: mergeSeeds(contributions, contributions.length),
      byStrategy,
      budget,
    }),
    budget,
    graphUnavailable,
    byStrategy,
  };
}

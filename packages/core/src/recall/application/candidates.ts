import type { Seed, SeedProvenance } from './seeds.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { CurrencyAnnotation } from '../../infrastructure/graph/read-modes.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { ActivatedNode, ActivationSeed } from '../domain/activation.js';
import type { Measurement } from '../domain/admission.js';
import type { FusionCandidate, RankedList } from '../domain/fusion.js';
import { SEED_STRATEGY_METHODS } from '../domain/seed-selection.js';

/**
 * The adapter between the retrieval stages and fusion: seed selection and spreading
 * activation both produce graph rows, and this is where those rows become the ranked lists
 * fusion consumes, each candidate carrying the rationale the pack explains it with.
 */

export type TraversalInput = {
  readonly seeds: readonly Seed[];
  /** The spread's activated set, which includes the seeds. */
  readonly activated: readonly ActivatedNode[];
  /** Content for activated ids no seed strategy already carried, keyed by node id. */
  readonly hydrated: ReadonlyMap<string, SeedCandidate>;
  /**
   * What arrival scoring measured for the ids the spread reached on its own, keyed by node
   * id. An id with no entry has no content vector to measure yet; omitting the map entirely
   * is the same state for every arrival, which is what a run whose cues never embedded gets.
   */
  readonly arrivalEvidence?: ReadonlyMap<string, readonly Measurement[]>;
};

export type RankedListInput = TraversalInput & {
  readonly byStrategy: {
    readonly vector: readonly Seed[];
    readonly bm25: readonly Seed[];
  };
};

/** The activated ids no seed strategy found: what the spread reached on its own. */
export function arrivalIds(seeds: readonly Seed[], activated: readonly ActivatedNode[]): string[] {
  const known = new Set(seeds.map((seed) => seed.id));
  return activated.map((node) => node.nodeId).filter((id) => !known.has(id));
}

/**
 * Everything the first pass produced, which is what a later stage's hit has to be new against.
 * The three sets overlap heavily on a normal run; the union is what makes "found by neither seed
 * nor spread" a property of the id rather than of which stage was asked.
 */
export function firstPassIds(
  seeds: readonly Seed[],
  activated: readonly ActivatedNode[],
  items: readonly { readonly id: string }[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const seed of seeds) {
    ids.add(seed.id);
  }
  for (const node of activated) {
    ids.add(node.nodeId);
  }
  for (const item of items) {
    ids.add(item.id);
  }
  return ids;
}

function annotationOf(candidate: SeedCandidate): CurrencyAnnotation {
  if (candidate.supersededBy === undefined) {
    return { currency: candidate.currency };
  }
  return { currency: candidate.currency, supersededBy: candidate.supersededBy };
}

export function toActivationSeed(seed: Seed): ActivationSeed {
  return {
    nodeId: seed.id,
    currency: annotationOf(seed),
    ...(seed.isStructural === undefined ? {} : { isStructural: seed.isStructural }),
  };
}

function baseCandidate(candidate: SeedCandidate): Omit<FusionCandidate, 'rationale' | 'relevance'> {
  return {
    id: candidate.id,
    labels: candidate.labels,
    content: candidate.content,
    ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
    ...(candidate.isStructural === undefined ? {} : { isStructural: candidate.isStructural }),
    ...(candidate.sourceEpisodeId === undefined
      ? {}
      : { sourceEpisodeId: candidate.sourceEpisodeId }),
    ...(candidate.why === undefined ? {} : { why: candidate.why }),
    ...(candidate.mentionCount === undefined ? {} : { mentionCount: candidate.mentionCount }),
    ...annotationOf(candidate),
  };
}

function toMeasurement(provenance: SeedProvenance): Measurement {
  return {
    method: SEED_STRATEGY_METHODS[provenance.strategy],
    relevance: provenance.relevance,
    ...(provenance.exact === undefined ? {} : { exact: provenance.exact }),
    ...(provenance.cue === undefined ? {} : { cue: provenance.cue }),
  };
}

/**
 * A seed is explained by the strategy that found it, at that strategy's own score, never by
 * the activation pass, which re-encounters every seed at 1.0 and would otherwise flatten
 * four distinct retrieval stories into one.
 *
 * The rationale carries the ranking score (weighted by the cue's bucket, so the reader sees
 * why it sits where it sits); `relevance` carries the unweighted measurement the floor reads.
 * A recent-turn cue that matched perfectly ranks last and still surfaces.
 */
export function seedCandidate(seed: Seed): FusionCandidate | undefined {
  const best = seed.provenance[0];
  if (best === undefined) {
    return undefined;
  }
  return {
    ...baseCandidate(seed),
    rationale: { method: SEED_STRATEGY_METHODS[best.strategy], score: seed.score },
    relevance: seed.relevance,
    // Every strategy that found it, not just the strongest: the admission gate counts
    // independent measurements, and a maximum cannot tell one hit from three.
    evidence: seed.provenance.map(toMeasurement),
  };
}

/**
 * An item no seed strategy found: reached by traversal alone, and its path says how.
 *
 * The rationale stays activation because that is how the node was found and the activation
 * score is what ranks it. The evidence is the cosine arrival scoring measured against the
 * query cues, which is what the gate reads: an arrival is admitted for answering the query,
 * never for being reachable. `relevance` stays zero for the same reason it does on a recency
 * hit, since the producing method's own number measures connection rather than relevance.
 */
function activatedCandidate(
  node: ActivatedNode,
  candidate: SeedCandidate,
  evidence: readonly Measurement[],
): FusionCandidate {
  return {
    ...baseCandidate(candidate),
    rationale: { method: 'activation', score: node.score, path: node.pathSummary },
    relevance: 0,
    evidence,
    activation: node.score,
    ...(node.typedEvidence === undefined ? {} : { typedEvidence: node.typedEvidence }),
  };
}

/**
 * The graph leg. Activation order is the rank, and because the spread returns the seeds
 * inside the activated set, this list is where a seed found only by entity resolution or
 * recency enters fusion at all. A seed that fell under `min_activation` is appended rather
 * than lost, since the strategy still found it.
 */
export function traversalCandidates(input: TraversalInput): readonly FusionCandidate[] {
  const bySeedId = new Map(input.seeds.map((seed) => [seed.id, seed]));
  const placed = new Set<string>();
  const candidates: FusionCandidate[] = [];

  for (const node of input.activated) {
    const seed = bySeedId.get(node.nodeId);
    if (seed !== undefined) {
      const candidate = seedCandidate(seed);
      if (candidate !== undefined) {
        placed.add(node.nodeId);
        candidates.push(candidate);
      }
      continue;
    }
    const hit = input.hydrated.get(node.nodeId);
    if (hit !== undefined) {
      placed.add(node.nodeId);
      candidates.push(activatedCandidate(node, hit, input.arrivalEvidence?.get(node.nodeId) ?? []));
    }
  }

  for (const seed of input.seeds) {
    if (placed.has(seed.id)) {
      continue;
    }
    const candidate = seedCandidate(seed);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function seedCandidates(seeds: readonly Seed[]): readonly FusionCandidate[] {
  const candidates: FusionCandidate[] = [];
  for (const seed of seeds) {
    const candidate = seedCandidate(seed);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * One list per method `config.search.methods` names, weighted by `config.search.weights`.
 * Dropping a method drops its list from the fusion, not its strategy from seed selection:
 * the strategies are how recall finds anything at all, the lists are how much each way of
 * finding it counts.
 */
export function buildRankedLists(config: Config, input: RankedListInput): readonly RankedList[] {
  const enabled = new Set(config.search.methods);
  const lists: RankedList[] = [];

  if (enabled.has('vector')) {
    lists.push({
      leg: 'vector',
      weight: config.search.weights.vector,
      candidates: seedCandidates(input.byStrategy.vector),
    });
  }
  if (enabled.has('bm25')) {
    lists.push({
      leg: 'bm25',
      weight: config.search.weights.bm25,
      candidates: seedCandidates(input.byStrategy.bm25),
    });
  }
  if (enabled.has('graph_traversal')) {
    lists.push({
      leg: 'graph_traversal',
      weight: config.search.weights.graph,
      candidates: traversalCandidates(input),
    });
  }

  return lists;
}

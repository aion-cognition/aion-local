import type { Config } from '../../infrastructure/config/schema.js';
import type { CurrencyAnnotation } from '../../infrastructure/graph/read-modes.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { ActivatedNode, ActivationSeed } from '../domain/activation.js';
import type { Measurement } from '../domain/admission.js';
import type { FusionCandidate, RankedList } from '../domain/fusion.js';
import type { Seed, SeedProvenance } from './seeds.js';

/**
 * The adapter between the retrieval stages and fusion: seed selection and spreading
 * activation both produce graph rows, and this is where those rows become the ranked lists
 * whitepaper §5.3 fuses, each candidate carrying the rationale §5.7 will explain it with.
 */

export type TraversalInput = {
  readonly seeds: readonly Seed[];
  /** Whitepaper Algorithm 2's activated set, which includes the seeds. */
  readonly activated: readonly ActivatedNode[];
  /** Content for activated ids no seed strategy already carried, keyed by node id. */
  readonly hydrated: ReadonlyMap<string, SeedCandidate>;
};

export type RankedListInput = TraversalInput & {
  readonly byStrategy: {
    readonly vector: readonly Seed[];
    readonly bm25: readonly Seed[];
  };
};

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
    ...annotationOf(candidate),
  };
}

function toMeasurement(provenance: SeedProvenance): Measurement {
  return {
    method: provenance.strategy,
    relevance: provenance.relevance,
    ...(provenance.exact === undefined ? {} : { exact: provenance.exact }),
    ...(provenance.cue === undefined ? {} : { cue: provenance.cue }),
  };
}

/**
 * A seed is explained by the strategy that found it, at that strategy's own score — never
 * by the activation pass, which re-encounters every seed at 1.0 and would otherwise
 * flatten four distinct retrieval stories into one.
 *
 * The rationale carries the ranking score (weighted by the cue's Algorithm 1 bucket, so the
 * reader sees why it sits where it sits); `relevance` carries the unweighted measurement the
 * floor reads. A recent-turn cue that matched perfectly ranks last and still surfaces.
 */
export function seedCandidate(seed: Seed): FusionCandidate | undefined {
  const best = seed.provenance[0];
  if (best === undefined) {
    return undefined;
  }
  return {
    ...baseCandidate(seed),
    rationale: { method: best.strategy, score: seed.score },
    relevance: seed.relevance,
    // Every strategy that found it, not just the strongest: the admission gate counts
    // independent measurements, and a maximum cannot tell one hit from three.
    evidence: seed.provenance.map(toMeasurement),
  };
}

/** An item no seed strategy found: reached by traversal alone, and its path says how. */
function activatedCandidate(node: ActivatedNode, candidate: SeedCandidate): FusionCandidate {
  return {
    ...baseCandidate(candidate),
    rationale: { method: 'activation', score: node.score, path: node.pathSummary },
    relevance: 0,
    // No retrieval leg measured it, so it carries no evidence of its own and reaches a pack
    // only through the anchor rule.
    evidence: [],
    activation: node.score,
  };
}

/**
 * The graph leg. Activation order is the rank, and because Algorithm 2 returns the seeds
 * inside the activated set, this list is where a seed found only by entity resolution or
 * recency enters fusion at all. A seed that fell under `min_activation` is appended rather
 * than lost — the strategy still found it.
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
      candidates.push(activatedCandidate(node, hit));
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

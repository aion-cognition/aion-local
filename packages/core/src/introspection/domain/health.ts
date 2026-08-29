import {
  REFLECTION_LANES,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * One reading of the substrate's health, taken at the top of every maintenance tick and
 * carried unchanged through decide, act, and learn. It is a value, not a handle: nothing in it
 * reads the graph again, so a decision can be replayed from a stored snapshot and reach the
 * same answer.
 *
 * `degraded` is what makes a partial reading usable. A metric collector that throws does not
 * end the tick; its fields keep the neutral value declared beside them and the collector's
 * name lands here, so a rule that would otherwise read a fallback as a pathology can tell the
 * two apart.
 */

export type GraphStructureHealth = {
  readonly nodes: number;
  readonly relationships: number;
  /** Current content-bearing nodes carrying text: the population that should hold a content vector. */
  readonly vectorExpected: number;
  readonly vectorPresent: number;
  /** Present over expected. 1 when nothing is expected, since an empty substrate is not behind. */
  readonly vectorParity: number;
  readonly orphanNodes: number;
  /** Orphans over content-bearing nodes. 0 on an empty substrate. */
  readonly orphanShare: number;
  /** Episodes with no `PARTICIPATES_IN` edge to a session: the missing-backbone condition. */
  readonly episodesWithoutSession: number;
  /** Standing narratives written under an older grounding revision. */
  readonly staleNarratives: number;
};

export type QueueHealth = {
  readonly depthByLane: Readonly<Record<ReflectionLane, number>>;
  readonly depth: number;
  readonly oldestUnclaimedMs: number | undefined;
  /** Unclaimed jobs past the attempt ceiling: no worker will ever take them again. */
  readonly exhausted: number;
  readonly p95EnrichmentLagMs: number | undefined;
};

export type EnrichmentHealth = {
  readonly episodes: number;
  /** Stored, unenriched, and unqueued: nothing will ever pick them up without a re-enqueue. */
  readonly unenriched: number;
  readonly queued: number;
  /** True when the scan limit cut the pass, so the counts are a floor. */
  readonly truncated: boolean;
};

export type RedactionHealth = {
  readonly scanned: number;
  /** Nodes whose stored text still matches a current redaction rule. */
  readonly leaking: number;
};

export type ProposalHealth = {
  readonly supersessionOpen: number;
  readonly entityMergeOpen: number;
  /** Age of the oldest open proposal; `undefined` when none are open. */
  readonly oldestOpenAgeMs: number | undefined;
  /** Median age of the open proposals, which separates one forgotten row from a stalled queue. */
  readonly medianOpenAgeMs: number | undefined;
};

export type PlasticityHealth = {
  readonly reinforcementQueueDepth: number;
  readonly reinforcementLastRunAt: string | undefined;
  readonly decayLastRunAt: string | undefined;
};

/** What running an operation has done for the substrate, carried into the snapshot for tier 2 and for `aion stats`. */
export type OperationEffectiveness = {
  readonly name: string;
  readonly runs: number;
  readonly improved: number;
  readonly failed: number;
  /** Improved runs over resolved runs; 1 for an operation that has never run, so a new one is not born deprioritized. */
  readonly effectiveness: number;
  /** Cycles since this operation was last selected. Starvation protection reads it. */
  readonly cyclesSinceSelected: number;
  readonly lastRunAt: string | undefined;
};

export type HealthSnapshot = {
  readonly observedAt: string;
  readonly cycle: number;
  readonly graph: GraphStructureHealth;
  readonly queue: QueueHealth;
  readonly enrichment: EnrichmentHealth;
  readonly redaction: RedactionHealth;
  readonly proposals: ProposalHealth;
  readonly plasticity: PlasticityHealth;
  readonly effectiveness: readonly OperationEffectiveness[];
  /** Collectors that failed and fell back to a neutral reading, named so a rule can discount them. */
  readonly degraded: readonly string[];
};

/**
 * Collector names, which are what lands in `degraded`. Shared so a rule that discounts a
 * fallback reading and the collector that produced it agree on the spelling.
 */
export const HEALTH_COLLECTORS = {
  graph: 'graph',
  queue: 'queue',
  enrichment: 'enrichment',
  redaction: 'redaction',
  proposals: 'proposals',
  plasticity: 'plasticity',
} as const;

export type HealthCollector = (typeof HEALTH_COLLECTORS)[keyof typeof HEALTH_COLLECTORS];

/** Neutral readings: what a collector's fields hold when it failed and its name went to `degraded`. */
export const NEUTRAL_GRAPH_HEALTH: GraphStructureHealth = {
  nodes: 0,
  relationships: 0,
  vectorExpected: 0,
  vectorPresent: 0,
  vectorParity: 1,
  orphanNodes: 0,
  orphanShare: 0,
  episodesWithoutSession: 0,
  staleNarratives: 0,
};

export const NEUTRAL_QUEUE_HEALTH: QueueHealth = {
  depthByLane: Object.fromEntries(REFLECTION_LANES.map((lane) => [lane, 0])) as Record<
    ReflectionLane,
    number
  >,
  depth: 0,
  oldestUnclaimedMs: undefined,
  exhausted: 0,
  p95EnrichmentLagMs: undefined,
};

export const NEUTRAL_ENRICHMENT_HEALTH: EnrichmentHealth = {
  episodes: 0,
  unenriched: 0,
  queued: 0,
  truncated: false,
};

export const NEUTRAL_REDACTION_HEALTH: RedactionHealth = { scanned: 0, leaking: 0 };

export const NEUTRAL_PROPOSAL_HEALTH: ProposalHealth = {
  supersessionOpen: 0,
  entityMergeOpen: 0,
  oldestOpenAgeMs: undefined,
  medianOpenAgeMs: undefined,
};

export const NEUTRAL_PLASTICITY_HEALTH: PlasticityHealth = {
  reinforcementQueueDepth: 0,
  reinforcementLastRunAt: undefined,
  decayLastRunAt: undefined,
};

/**
 * A reading of nothing. The engine falls back to it when observation itself fails, so a cycle
 * that cannot see the substrate decides to do nothing rather than acting on a picture it does
 * not have. Every neutral value is chosen so no rule fires on it.
 */
export function neutralSnapshot(cycle: number, observedAt: string): HealthSnapshot {
  return {
    observedAt,
    cycle,
    graph: NEUTRAL_GRAPH_HEALTH,
    queue: NEUTRAL_QUEUE_HEALTH,
    enrichment: NEUTRAL_ENRICHMENT_HEALTH,
    redaction: NEUTRAL_REDACTION_HEALTH,
    proposals: NEUTRAL_PROPOSAL_HEALTH,
    plasticity: NEUTRAL_PLASTICITY_HEALTH,
    effectiveness: [],
    degraded: Object.values(HEALTH_COLLECTORS),
  };
}

/** A ratio that answers 1 rather than NaN on an empty substrate: nothing missing is not a gap. */
export function parityRatio(present: number, expected: number): number {
  if (expected <= 0) {
    return 1;
  }
  return present / expected;
}

/** A share that answers 0 rather than NaN on an empty substrate. */
export function share(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return part / total;
}

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
  /**
   * Orphans over content-bearing nodes, as a diagnostic. Physical disconnection says spreading
   * activation cannot reach a node through associations; it does not say the records hold
   * nothing up, so nothing is repaired or suppressed on this reading alone.
   */
  readonly orphanShare: number;
  /** Disconnected nodes a repair run could act on now: due relinks and mature qualified forgets. */
  readonly orphanActionable: number;
  /** Disconnected nodes whose support nothing has counted, which authorizes no repair at all. */
  readonly orphanUnknownSupport: number;
  /** The batch bound the count above was taken under, which is what a demand score divides by. */
  readonly orphanCleanupBatch: number;
  /** Episodes with no `PARTICIPATES_IN` edge to a session: the missing-backbone condition. */
  readonly episodesWithoutSession: number;
  /** Standing narratives written under an older grounding revision. */
  readonly staleNarratives: number;
  /** Unprotected edges the decay sweep could act on. Zero on a graph of only backbone links. */
  readonly decayableEdges: number;
  /**
   * Open association edges decay has driven to the weight floor: the narrower population inside
   * `decayableEdges` that `edge_prune` is the operation for, and the only one a run of it moves.
   */
  readonly atFloorAssociationEdges: number;
};

export type QueueHealth = {
  readonly depthByLane: Readonly<Record<ReflectionLane, number>>;
  readonly depth: number;
  readonly oldestUnclaimedMs: number | undefined;
  /** Unclaimed jobs past the attempt ceiling: no worker will ever take them again. */
  readonly exhausted: number;
  /**
   * Claimable `source_index` rows. Its own number rather than part of `depth`, because the
   * reflection worker never claims one and the advisor would otherwise be scored against a
   * reflection backlog that was really the index backlog.
   */
  readonly indexDepth: number;
  readonly p95EnrichmentLagMs: number | undefined;
  /** Exhausted jobs `dead_letter` already gave their one retry, which failed again: needs a person. */
  readonly deadLetterAttentionCount: number;
  /**
   * Share of recent recalls that answered without the cue model. `undefined` until the first
   * recall lands, so a fresh install reads as unmeasured rather than as healthy.
   */
  readonly cueDegradedRate: number | undefined;
  /** Reinforcement signals the queue cap threw away: recall the substrate never learned from. */
  readonly reinforcementDropped: number;
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

/**
 * What the deterministic sweep has left to do. Counted from the graph rather than from the
 * proposal queue, because the two are different populations: the queue holds the residue a
 * judge split on, and the sweep only ever absorbs spellings no judge was asked about.
 */
export type EntityHealth = {
  /**
   * Current identities holding a tier-0 relation to another current identity: one squashed
   * name key shared, or an unambiguous alias equal to another identity's folded name. A floor
   * rather than a total when the scan limit cuts the read.
   */
  readonly tier0Eligible: number;
  /**
   * Current entities whose name is machine-minted rather than spoken: a digest, a UUID, a path,
   * an agent id. The population `identifier_decay` closes, and a floor rather than a total when
   * the scan limit cuts the read.
   */
  readonly identifierShaped: number;
};

/**
 * What the substrate's own model calls have done. A generation ends at a provider the loop does
 * not own, so this is the one health reading about something outside the substrate: a remote
 * route failing every call is a number here rather than a log line nobody tails.
 */
export type GenerationHealth = {
  readonly calls: number;
  readonly failed: number;
  /** Failures over calls, `undefined` until the first generation: no calls is not a clean record. */
  readonly failureRate: number | undefined;
};

/**
 * What the chunk lifecycle owes, read from the manifest rather than from the graph.
 *
 * Every count here distinguishes zero from unknown, because the two authorize opposite things: a
 * measured zero says the substrate is caught up, and an unreadable manifest says nothing at all.
 * The fresh census and the pending publication are read independently, so a known interrupted
 * publication still calls for a run on a tick whose census could not be taken.
 */
export type SealDemand = {
  /**
   * Groups a run could act on now: sessions whose tail has reached a trigger, plus sealed chunks
   * whose next attempt is due. Both spend one bounded unit of the same run, which is what makes
   * the sum a denominator rather than a mixture. `undefined` when the census could not be taken.
   */
  readonly eligibleGroups: number | undefined;
  /** The seal half of the sum above, reported apart so nothing divides a mixed total. */
  readonly dueRemainders: number | undefined;
  /** The publication half. */
  readonly dueChunks: number | undefined;
  /**
   * Tails a bounded discovery OFFERED, which is a different claim from the counts above.
   *
   * The rendered-input trigger is knowable only to the admission decision, and an observation tick
   * has no resolver to render with. What durable state can measure is which bound a tail reaches
   * first, and that measure over-reports: a tail it offers may turn out to fit and answer
   * `waiting`. So the offer is counted here and never inside `eligibleGroups`, which says PROVED.
   * A run still spends an evidence read on each of these, which is why the score sees them.
   */
  readonly inputCandidates: number | undefined;
  /** Elapsed arrival age of the oldest eligible group. Blocked groups never set it. */
  readonly oldestEligibleAgeMs: number | undefined;
  /**
   * Published chunk heads whose own stored dependency set no longer verifies, counted to the same
   * ceiling as the groups above and reported as the floor it is. It is the regrounding half of the
   * lifecycle's demand, and it lives here rather than beside the graph counts because it is a
   * question the manifest answers: the legacy grounding marker on a node says nothing about a chunk
   * family, so a substrate with no stale marker at all can still owe a rewrite.
   */
  readonly invalidatedHeads: number | undefined;
  /** Sources a recorded block holds out of publication, by the reason recorded against it. */
  readonly blockedSourcesByReason: Readonly<Record<string, number>>;
  readonly blockedOldestAgeMs: number | undefined;
  /**
   * A durable publication the coordinator prepared and has not settled. `undefined` where the
   * control record itself could not be read, which is not the same as none pending.
   */
  readonly pendingPublishedRepair: boolean | undefined;
  /** Whether the fresh census above was taken at all. */
  readonly availability: 'measured' | 'unavailable';
  /** Why, where either half is unavailable. */
  readonly diagnostic?: string;
};

/**
 * What the substrate could evict now, and what it already owes an eviction that committed.
 *
 * The two halves are read independently and neither stands in for the other. A census nobody
 * could take is `unavailable`, which is not zero eligible sources: scoring an unreadable reading
 * as no demand would quietly stop the operation, and scoring it as demand would run it on a
 * population nobody counted. Work a committed receipt already created is known from durable
 * records alone, so it survives a census failure and still calls for the run that discharges it.
 */
export type EvictionDemand = {
  /** Sources that pass every durable eligibility condition now. `undefined` when the census failed. */
  readonly eligibleSources: number | undefined;
  readonly eligibleTurns: number | undefined;
  /**
   * Archived payload bytes behind the eligible sources. An estimate of what the raw text weighs,
   * never a claim about released disk space or a page cache: C0 measures those separately.
   */
  readonly estimatedBytes: number | undefined;
  readonly oldestQualifiedAgeMs: number | undefined;
  /** Sources the scan examined and refused, by the condition that refused them. */
  readonly pinsByReason: Readonly<Record<string, number>>;
  /** Survivor tasks an acknowledged eviction made runnable and nothing has discharged. */
  readonly pendingSurvivorWork: number | undefined;
  /** A durable publication the coordinator prepared and has not settled. */
  readonly pendingRecovery: boolean | undefined;
  readonly availability: 'measured' | 'unavailable';
  readonly diagnostic?: string;
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
  /**
   * Improved runs over the runs a declared metric scored, failures included: a run that threw
   * scored no metric and still counts against the ratio, which is what makes an operation that
   * keeps failing weigh less than one that keeps running. Undefined where there is nothing to
   * divide: an operation that declares no metric, or one whose runs have none scored yet. Every
   * consumer reads the absence as "no verdict" rather than substituting a number, so an
   * operation is never weighted on a reading nothing could have contradicted.
   */
  readonly effectiveness: number | undefined;
  /** Cycles since this operation was last selected. Starvation protection reads it. */
  readonly cyclesSinceSelected: number;
  readonly lastRunAt: string | undefined;
  /** What a run of it typically costs, so the cheapest way to answer a reading is a fact and not a guess. */
  readonly meanDurationMs: number | undefined;
};

export type HealthSnapshot = {
  readonly observedAt: string;
  readonly cycle: number;
  readonly graph: GraphStructureHealth;
  readonly queue: QueueHealth;
  readonly enrichment: EnrichmentHealth;
  readonly redaction: RedactionHealth;
  readonly proposals: ProposalHealth;
  readonly entities: EntityHealth;
  readonly narrativeSeal: SealDemand;
  readonly eviction: EvictionDemand;
  readonly plasticity: PlasticityHealth;
  readonly generation: GenerationHealth;
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
  entities: 'entities',
  narrativeSeal: 'narrative_seal',
  eviction: 'eviction',
  plasticity: 'plasticity',
  generation: 'generation',
  effectiveness: 'effectiveness',
} as const;

/** Neutral readings: what a collector's fields hold when it failed and its name went to `degraded`. */
export const NEUTRAL_GRAPH_HEALTH: GraphStructureHealth = {
  nodes: 0,
  relationships: 0,
  vectorExpected: 0,
  vectorPresent: 0,
  vectorParity: 1,
  orphanShare: 0,
  orphanActionable: 0,
  orphanUnknownSupport: 0,
  orphanCleanupBatch: 0,
  episodesWithoutSession: 0,
  staleNarratives: 0,
  decayableEdges: 0,
  atFloorAssociationEdges: 0,
};

export const NEUTRAL_QUEUE_HEALTH: QueueHealth = {
  depthByLane: Object.fromEntries(REFLECTION_LANES.map((lane) => [lane, 0])) as Record<
    ReflectionLane,
    number
  >,
  depth: 0,
  oldestUnclaimedMs: undefined,
  exhausted: 0,
  indexDepth: 0,
  p95EnrichmentLagMs: undefined,
  deadLetterAttentionCount: 0,
  cueDegradedRate: undefined,
  reinforcementDropped: 0,
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

export const NEUTRAL_ENTITY_HEALTH: EntityHealth = { tier0Eligible: 0, identifierShaped: 0 };

/**
 * A reading nothing could be taken from. Unlike the counts above it, the neutral value here is
 * not zero: a manifest nobody could read has to say so, or a seal run would be scored against a
 * backlog of nothing while the backlog stood.
 */
export const NEUTRAL_SEAL_DEMAND: SealDemand = {
  eligibleGroups: undefined,
  dueRemainders: undefined,
  dueChunks: undefined,
  inputCandidates: undefined,
  oldestEligibleAgeMs: undefined,
  invalidatedHeads: undefined,
  blockedSourcesByReason: {},
  blockedOldestAgeMs: undefined,
  pendingPublishedRepair: undefined,
  availability: 'unavailable',
  diagnostic: 'the narrative manifest was not read on this tick',
};

export const NEUTRAL_EVICTION_DEMAND: EvictionDemand = {
  eligibleSources: undefined,
  eligibleTurns: undefined,
  estimatedBytes: undefined,
  oldestQualifiedAgeMs: undefined,
  pinsByReason: {},
  pendingSurvivorWork: undefined,
  pendingRecovery: undefined,
  availability: 'unavailable',
  diagnostic: 'the eviction census was not read on this tick',
};

export const NEUTRAL_GENERATION_HEALTH: GenerationHealth = {
  calls: 0,
  failed: 0,
  failureRate: undefined,
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
    entities: NEUTRAL_ENTITY_HEALTH,
    narrativeSeal: NEUTRAL_SEAL_DEMAND,
    eviction: NEUTRAL_EVICTION_DEMAND,
    plasticity: NEUTRAL_PLASTICITY_HEALTH,
    generation: NEUTRAL_GENERATION_HEALTH,
    effectiveness: [],
    degraded: Object.values(HEALTH_COLLECTORS),
  };
}

/** Below this, a significant share of the substrate is invisible to vector search. */
export const CRITICAL_VECTOR_PARITY = 0.8;

/**
 * Neither share means anything on a substrate this small: one unvectorized node out of five is
 * a parity of 0.8, and the reflection worker's own pending-vector drain is already on it.
 */
export const CRITICAL_MIN_POPULATION = 20;

export type CriticalCondition = 'vector_parity' | 'missing_backbone_links';

/**
 * The tier-1 conditions this snapshot meets. An operation names the one condition it repairs
 * and reads it from here rather than re-deriving the thresholds, so the condition that selects
 * an operation and the condition the operation repairs cannot drift apart. Every consumer tests
 * membership; which critical operation preempts is decided on relevance in `decide.ts`.
 */
export function criticalConditions(health: HealthSnapshot): readonly CriticalCondition[] {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return [];
  }
  const conditions: CriticalCondition[] = [];
  if (health.graph.episodesWithoutSession > 0) {
    conditions.push('missing_backbone_links');
  }
  if (
    health.graph.vectorExpected >= CRITICAL_MIN_POPULATION &&
    health.graph.vectorParity < CRITICAL_VECTOR_PARITY
  ) {
    conditions.push('vector_parity');
  }
  return conditions;
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

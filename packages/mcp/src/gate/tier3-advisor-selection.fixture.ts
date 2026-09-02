import { introspectionOperations, type HealthSnapshot, type OperationCandidate } from '@aion/core';
import {
  NEUTRAL_ENRICHMENT_HEALTH,
  NEUTRAL_ENTITY_HEALTH,
  NEUTRAL_GRAPH_HEALTH,
  NEUTRAL_PLASTICITY_HEALTH,
  NEUTRAL_PROPOSAL_HEALTH,
  NEUTRAL_QUEUE_HEALTH,
  NEUTRAL_REDACTION_HEALTH,
  type EnrichmentHealth,
  type EntityHealth,
  type GraphStructureHealth,
  type OperationEffectiveness,
  type PlasticityHealth,
  type ProposalHealth,
  type QueueHealth,
  type RedactionHealth,
} from '@aion/core/introspection/domain/health.js';

/**
 * Twenty-four readings a substrate can actually take, each one a cycle the deterministic tiers
 * leave idle. Every case names what the reading calls for, decided from the numbers before any
 * model saw them.
 *
 * Three constraints shape every fixture, and each of them comes from a formula rather than
 * from taste:
 *
 * `community_refresh` answers a flat 0.2 on any populated graph the collector could read,
 * which is exactly the default urgency threshold and would be selected at tier 2. A fixture
 * with twenty nodes or more therefore carries an effectiveness row for it under the
 * deprioritization floor, which halves its urgency to 0.1; a fixture with a smaller graph gets
 * 0 from the same formula and needs no row.
 *
 * The standing cadences are in every reading and none of them is evidence of work:
 * `memory_decay` and `symbiosis_bridge` sit at 0.15, `narrative_cleanup` and
 * `description_freshness` at 0.15 before their own record weighs them down, and
 * `retro_judgment_sweep` at 0.1. A case that names an operation therefore has to put that
 * operation above 0.15, which is what keeps the answer arguable from the numbers:
 * `dead_letter` reads exhausted over 50, `reinforcement_flush` reads queue depth over 100, and
 * `reconcile_reenqueue` reads unenriched episodes over 200.
 *
 * Nothing here is a fixture about a pathology the snapshot does not encode.
 * `retro_judgment_sweep` has a flat relevance and no gauge, so a case "about" it would measure
 * nothing; it appears as a candidate and never as an answer.
 */

export const NO_OPERATION = 'none';

const OBSERVED_AT = '2026-08-30T12:00:00.000Z';
/** Half an hour back, which holds `memory_decay` at its standing floor rather than ramping it. */
const RECENT_DECAY = '2026-08-30T11:30:00.000Z';

export type Tier3Case = {
  readonly key: string;
  readonly health: HealthSnapshot;
  /** The operation the reading calls for, or `none`. */
  readonly expected: string;
  /** Why that is the answer, in the numbers. */
  readonly truthNote: string;
};

/** One second a run, so the cost line the advisor now reads carries the same value for every row. */
const FIXTURE_RUN_COST_MS = 1_000;

function row(
  name: string,
  runs: number,
  improved: number,
  cyclesSinceSelected: number,
): OperationEffectiveness {
  return {
    name,
    runs,
    improved,
    failed: 0,
    effectiveness: runs === 0 ? undefined : improved / runs,
    cyclesSinceSelected,
    lastRunAt: undefined,
    meanDurationMs: FIXTURE_RUN_COST_MS,
  };
}

/**
 * What a populated fixture carries. The `community_refresh` row is load-bearing: without it
 * that operation's flat 0.2 equals the threshold and the cycle is a tier-2 selection rather
 * than the tier-3 cycle every case here is about.
 */
const POPULATED_RECORD: readonly OperationEffectiveness[] = [
  row('community_refresh', 6, 1, 1),
  row('dead_letter', 4, 3, 0),
  row('reinforcement_flush', 9, 8, 0),
  row('reconcile_reenqueue', 3, 2, 0),
  row('narrative_cleanup', 6, 1, 3),
  row('description_freshness', 4, 1, 2),
];

const SMALL_RECORD: readonly OperationEffectiveness[] = [
  row('dead_letter', 2, 2, 0),
  row('reinforcement_flush', 4, 3, 0),
  row('narrative_cleanup', 4, 1, 3),
];

function graph(overrides: Partial<GraphStructureHealth> = {}): GraphStructureHealth {
  return { ...NEUTRAL_GRAPH_HEALTH, ...overrides };
}

/** A personal substrate a few sessions old: under the population floor every topology rule uses. */
function smallGraph(overrides: Partial<GraphStructureHealth> = {}): GraphStructureHealth {
  return graph({
    nodes: 14,
    relationships: 17,
    vectorExpected: 9,
    vectorPresent: 9,
    ...overrides,
  });
}

/** A working substrate: populated, connected, and fully vectorized. */
function populatedGraph(overrides: Partial<GraphStructureHealth> = {}): GraphStructureHealth {
  return graph({
    nodes: 148,
    relationships: 402,
    vectorExpected: 96,
    vectorPresent: 96,
    orphanNodes: 3,
    orphanShare: 0.02,
    decayableEdges: 210,
    // Part of the decayable mass has reached the floor, which is the narrower population
    // `edge_prune` acts on. Without it that operation reads as having nothing to do and leaves
    // the candidate table a competitor short of the substrate these cases describe.
    atFloorAssociationEdges: 150,
    ...overrides,
  });
}

function queue(overrides: Partial<QueueHealth> = {}): QueueHealth {
  return { ...NEUTRAL_QUEUE_HEALTH, ...overrides };
}

function enrichment(overrides: Partial<EnrichmentHealth> = {}): EnrichmentHealth {
  return { ...NEUTRAL_ENRICHMENT_HEALTH, ...overrides };
}

function redaction(overrides: Partial<RedactionHealth> = {}): RedactionHealth {
  return { ...NEUTRAL_REDACTION_HEALTH, ...overrides };
}

function proposals(overrides: Partial<ProposalHealth> = {}): ProposalHealth {
  return { ...NEUTRAL_PROPOSAL_HEALTH, ...overrides };
}

function plasticity(overrides: Partial<PlasticityHealth> = {}): PlasticityHealth {
  return { ...NEUTRAL_PLASTICITY_HEALTH, decayLastRunAt: RECENT_DECAY, ...overrides };
}

type Reading = {
  readonly graph: GraphStructureHealth;
  readonly queue?: QueueHealth;
  readonly enrichment?: EnrichmentHealth;
  readonly redaction?: RedactionHealth;
  readonly proposals?: ProposalHealth;
  readonly entities?: EntityHealth;
  readonly plasticity?: PlasticityHealth;
  readonly effectiveness: readonly OperationEffectiveness[];
};

function snapshot(reading: Reading): HealthSnapshot {
  return {
    observedAt: OBSERVED_AT,
    cycle: 412,
    graph: reading.graph,
    queue: reading.queue ?? queue(),
    enrichment: reading.enrichment ?? enrichment(),
    redaction: reading.redaction ?? redaction(),
    proposals: reading.proposals ?? proposals(),
    entities: reading.entities ?? NEUTRAL_ENTITY_HEALTH,
    plasticity: reading.plasticity ?? plasticity(),
    effectiveness: reading.effectiveness,
    degraded: [],
  };
}

/**
 * The candidate table the advisor sees, built from the shipped catalog and each operation's own
 * relevance. Nothing here restates a formula: a fixture that drifts away from the operation it
 * is about shows up as a decision that is no longer tier 3.
 */
export function candidatesFor(health: HealthSnapshot): readonly OperationCandidate[] {
  return introspectionOperations().map((operation) => {
    const answers = operation.answers === undefined ? {} : { answers: operation.answers };
    return { name: operation.name, ...answers, relevance: operation.relevance(health) };
  });
}

export const TIER3_SELECTION_BATTERY: readonly Tier3Case[] = [
  {
    key: 'exhausted-rows-waiting',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 12, exhausted: 9, oldestUnclaimedMs: 5_400_000 }),
      enrichment: enrichment({ episodes: 96, queued: 12 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'dead_letter',
    truthNote: 'nine attempts-exhausted rows are unclaimed and no worker will take them again',
  },
  {
    key: 'exhausted-rows-on-a-quiet-queue',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 9, exhausted: 9 }),
      enrichment: enrichment({ episodes: 88 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'dead_letter',
    truthNote: 'all nine unclaimed rows are exhausted, so the lane is stuck on them',
  },
  {
    key: 'exhausted-rows-on-a-small-substrate',
    health: snapshot({
      graph: smallGraph(),
      queue: queue({ depth: 9, exhausted: 9, oldestUnclaimedMs: 7_200_000 }),
      enrichment: enrichment({ episodes: 11, queued: 0 }),
      effectiveness: SMALL_RECORD,
    }),
    expected: 'dead_letter',
    truthNote: 'nine exhausted rows on a substrate of eleven episodes is most of its backlog',
  },
  {
    key: 'reinforcement-queue-nearly-a-full-batch',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      plasticity: plasticity({ reinforcementQueueDepth: 19 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reinforcement_flush',
    truthNote: 'nineteen reinforcements are queued and nothing else has a backlog at all',
  },
  {
    key: 'reinforcement-queue-with-recall-traffic',
    health: snapshot({
      graph: populatedGraph({ relationships: 610 }),
      queue: queue({ depth: 3 }),
      enrichment: enrichment({ episodes: 96, queued: 3 }),
      plasticity: plasticity({ reinforcementQueueDepth: 18 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reinforcement_flush',
    truthNote: 'eighteen queued reinforcements are the only reading above a standing cadence',
  },
  {
    key: 'reinforcement-queue-on-a-small-substrate',
    health: snapshot({
      graph: smallGraph({ relationships: 40 }),
      enrichment: enrichment({ episodes: 12 }),
      plasticity: plasticity({ reinforcementQueueDepth: 18 }),
      effectiveness: SMALL_RECORD,
    }),
    expected: 'reinforcement_flush',
    truthNote: 'eighteen weight updates are waiting on a graph of forty edges',
  },
  {
    key: 'unenriched-episodes-nothing-will-pick-up',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 134, unenriched: 38, queued: 0 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reconcile_reenqueue',
    truthNote: 'thirty-eight episodes are stored, unenriched, and in no queue',
  },
  {
    key: 'unenriched-episodes-beside-a-draining-queue',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 6, oldestUnclaimedMs: 120_000 }),
      enrichment: enrichment({ episodes: 140, unenriched: 36, queued: 6 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reconcile_reenqueue',
    truthNote: 'six episodes are queued and thirty-six others are in no queue at all',
  },
  {
    key: 'unenriched-episodes-after-a-crash',
    health: snapshot({
      graph: populatedGraph({
        nodes: 96,
        relationships: 210,
        vectorExpected: 60,
        vectorPresent: 60,
      }),
      enrichment: enrichment({ episodes: 88, unenriched: 35, queued: 0, truncated: false }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reconcile_reenqueue',
    truthNote: 'thirty-five episodes have no ledger key and no queue row, which only this closes',
  },
  {
    key: 'healthy-small-substrate',
    health: snapshot({
      graph: smallGraph(),
      enrichment: enrichment({ episodes: 11 }),
      redaction: redaction({ scanned: 14 }),
      effectiveness: SMALL_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'every gauge reads zero and only the standing cadences are above zero',
  },
  {
    key: 'healthy-populated-substrate',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      redaction: redaction({ scanned: 148 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'a fully vectorized connected graph with an empty queue has no work waiting',
  },
  {
    key: 'enrichment-in-flight',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 15, oldestUnclaimedMs: 45_000 }),
      enrichment: enrichment({ episodes: 110, unenriched: 0, queued: 15 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'fifteen episodes are queued and none are orphaned, so the worker is mid-drain',
  },
  {
    key: 'dead-letter-rows-already-retried',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 4, exhausted: 4, deadLetterAttentionCount: 4 }),
      enrichment: enrichment({ episodes: 96 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'all four exhausted rows already had their one retry, so a run changes nothing',
  },
  {
    key: 'open-supersession-proposals',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      proposals: proposals({
        supersessionOpen: 7,
        oldestOpenAgeMs: 10_800_000,
        medianOpenAgeMs: 3_600_000,
      }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote:
      'fresh open proposals are under every hygiene horizon, so nothing should run for them yet',
  },
  {
    key: 'slow-worker-shallow-queue',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 3, oldestUnclaimedMs: 900_000, p95EnrichmentLagMs: 780_000 }),
      enrichment: enrichment({ episodes: 96, queued: 3 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'three queued jobs draining slowly is a worker reading, not a maintenance backlog',
  },
  {
    key: 'reinforcement-queue-empty-after-a-long-gap',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      plasticity: plasticity({
        reinforcementQueueDepth: 0,
        reinforcementLastRunAt: '2026-08-27T09:00:00.000Z',
      }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'a flush with an empty queue drains nothing, however long ago the last one ran',
  },
  {
    key: 'redaction-scan-clean',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      redaction: redaction({ scanned: 600, leaking: 0 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'six hundred nodes scanned and nothing matches a redaction rule',
  },
  {
    key: 'small-substrate-just-seeded',
    health: snapshot({
      graph: smallGraph({ nodes: 6, relationships: 5, vectorExpected: 4, vectorPresent: 4 }),
      enrichment: enrichment({ episodes: 4, queued: 0 }),
      effectiveness: [],
    }),
    expected: NO_OPERATION,
    truthNote: 'four episodes and nothing pending: there is not enough substrate to maintain',
  },
  {
    key: 'exhausted-rows-and-a-shallow-reinforcement-queue',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 11, exhausted: 9 }),
      enrichment: enrichment({ episodes: 96, queued: 2 }),
      plasticity: plasticity({ reinforcementQueueDepth: 6 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'dead_letter',
    truthNote: 'nine exhausted rows outrank six queued reinforcements, which drain on their own',
  },
  {
    key: 'reinforcement-queue-and-a-couple-of-exhausted-rows',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 5, exhausted: 2 }),
      enrichment: enrichment({ episodes: 96 }),
      plasticity: plasticity({ reinforcementQueueDepth: 19 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reinforcement_flush',
    truthNote: 'nineteen queued reinforcements against two exhausted rows',
  },
  {
    key: 'unenriched-episodes-and-one-exhausted-row',
    health: snapshot({
      graph: populatedGraph(),
      queue: queue({ depth: 2, exhausted: 1 }),
      enrichment: enrichment({ episodes: 150, unenriched: 39, queued: 1 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'reconcile_reenqueue',
    truthNote: 'thirty-nine unqueued episodes against one exhausted row',
  },
  {
    key: 'entity-merge-proposals-open',
    health: snapshot({
      graph: populatedGraph(),
      enrichment: enrichment({ episodes: 96 }),
      proposals: proposals({ entityMergeOpen: 1, oldestOpenAgeMs: 86_400_000 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'one open merge proposal is a queue of one, and both merge lanes read it already',
  },
  {
    key: 'orphans-well-under-the-fragmentation-line',
    health: snapshot({
      graph: populatedGraph({ orphanNodes: 9, orphanShare: 0.06 }),
      enrichment: enrichment({ episodes: 96 }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: NO_OPERATION,
    truthNote: 'six percent orphans is far under the fragmentation line and its repair reads zero',
  },
  {
    key: 'exhausted-rows-with-nothing-else-moving',
    health: snapshot({
      graph: populatedGraph({ decayableEdges: 0 }),
      queue: queue({ depth: 9, exhausted: 9, oldestUnclaimedMs: 10_800_000 }),
      enrichment: enrichment({ episodes: 96 }),
      plasticity: plasticity({ decayLastRunAt: RECENT_DECAY }),
      effectiveness: POPULATED_RECORD,
    }),
    expected: 'dead_letter',
    truthNote: 'nine rows unclaimed for three hours, and no other gauge is above zero',
  },
];

import type { Driver } from 'neo4j-driver';

import type { Config } from '../../infrastructure/config/schema.js';
import { countEdgesByFloorBand } from '../../infrastructure/graph/edge-prune-queries.js';
import { countDecayableEdges } from '../../infrastructure/graph/edge-weights.js';
import { countTier0EligibleEntities } from '../../infrastructure/graph/entity-tier0-queries.js';
import { readCurrentEntityNamings } from '../../infrastructure/graph/identifier-decay-queries.js';
import {
  countEpisodesWithoutSession,
  countOrphanNodes,
  countVectorParity,
} from '../../infrastructure/graph/introspection-health.js';
import { countGraphElements } from '../../infrastructure/graph/introspection.js';
import { findStaleNarratives } from '../../infrastructure/graph/narrative-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countDeadLetterAttention } from '../../infrastructure/sqlite/dead-letter-queue.js';
import { listOpenEntityMergeProposalCreatedAt } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { generationCounters } from '../../infrastructure/sqlite/generation-counters.js';
import {
  listOperationStats,
  meanOperationDurationMs,
} from '../../infrastructure/sqlite/introspection-counters.js';
import { listOpenSupersessionProposalCreatedAt } from '../../infrastructure/sqlite/supersession-proposals.js';
import { plasticityCounters } from '../../plasticity/application/metrics.js';
import { scanRedactionResidue } from '../../redaction/residue.js';
import { queueLagSnapshot } from '../../reflection/application/lag.js';
import { reconcileEnrichment } from '../../reflection/application/reconcile.js';
import { NARRATIVE_GROUNDING } from '../../reflection/domain/narrative.js';
import {
  HEALTH_COLLECTORS,
  NEUTRAL_ENRICHMENT_HEALTH,
  NEUTRAL_ENTITY_HEALTH,
  NEUTRAL_GENERATION_HEALTH,
  NEUTRAL_GRAPH_HEALTH,
  NEUTRAL_PLASTICITY_HEALTH,
  NEUTRAL_PROPOSAL_HEALTH,
  NEUTRAL_QUEUE_HEALTH,
  NEUTRAL_REDACTION_HEALTH,
  parityRatio,
  share,
  type EnrichmentHealth,
  type EntityHealth,
  type GenerationHealth,
  type GraphStructureHealth,
  type HealthSnapshot,
  type OperationEffectiveness,
  type PlasticityHealth,
  type ProposalHealth,
  type QueueHealth,
  type RedactionHealth,
} from '../domain/health.js';
import { identifierShape } from '../domain/identifier-shape.js';
import type { OperationMeasurement } from '../domain/operation.js';

/**
 * One health reading, assembled from the surfaces that already answer these questions for
 * `aion doctor` and `/health`. Nothing here computes a new fact: the reconcile count, the
 * queue lag, the residue scan, and the plasticity counters are the same calls the operator
 * commands make, which is what keeps a tick's picture and a person's picture the same picture.
 *
 * Every collector is independent and every collector is caught. A Cypher timeout or a vector
 * index that has gone missing costs its own metrics and nothing else: the rest of the snapshot
 * still arrives, the failed collector's name lands in `degraded`, and the decision engine
 * proceeds on what it has. A maintenance loop that stops maintaining because one count failed
 * is the pathology it exists to prevent.
 */

/** Graph and enrichment scans stop here. Above it the answer is "the backlog", not a number. */
export const DEFAULT_OBSERVE_SCAN_LIMIT = 20_000;

/**
 * The residue scan reads and re-matches every string property it touches, so the tick takes a
 * bounded sample rather than the whole substrate. `scanned` travels with `leaking` for exactly
 * this reason: the share is the reading, the count alone is not.
 */
export const DEFAULT_OBSERVE_RESIDUE_LIMIT = 2_000;

export type ObserveDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
};

export type ObserveOptions = {
  /**
   * The registered catalog, so an operation with no history still appears with a zeroed record.
   * Each entry carries whether the operation declares a metric, because a record with no metric
   * behind it is reported as unmeasured rather than scored.
   */
  readonly operations?: readonly OperationMeasurement[];
  readonly cycle?: number;
  readonly now?: Date;
  readonly scanLimit?: number;
  readonly residueLimit?: number;
};

async function collect<T>(
  name: string,
  logger: Logger,
  degraded: string[],
  fallback: T,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    degraded.push(name);
    logger.warn({ err, collector: name }, 'introspection metric collector failed');
    return fallback;
  }
}

async function readGraph(
  driver: Driver,
  scanLimit: number,
  weightFloor: number,
): Promise<GraphStructureHealth> {
  const [counts, parity, orphans, missing, stale, decayableEdges, floorBands] = await Promise.all([
    countGraphElements(driver),
    countVectorParity(driver, scanLimit),
    countOrphanNodes(driver, scanLimit),
    countEpisodesWithoutSession(driver, scanLimit),
    findStaleNarratives(driver, NARRATIVE_GROUNDING, scanLimit),
    countDecayableEdges(driver),
    countEdgesByFloorBand(driver, weightFloor),
  ]);
  return {
    nodes: counts.nodes,
    relationships: counts.relationships,
    vectorExpected: parity.expected,
    vectorPresent: parity.vectored,
    vectorParity: parityRatio(parity.vectored, parity.expected),
    orphanShare: share(orphans.orphans, orphans.nodes),
    episodesWithoutSession: missing,
    staleNarratives: stale.length,
    decayableEdges,
    atFloorAssociationEdges: floorBands.atFloor,
  };
}

/**
 * The operator's lag reading, carried whole. The degraded-cue rate and the dropped
 * reinforcement rows are the two the operator has had all along and the loop could not see:
 * both describe recall answering worse than the substrate could, which is a condition an
 * operation can be written for and nothing can be written for while it is invisible.
 */
export function readQueue(db: SqliteHandle, config: Config, now: Date): QueueHealth {
  const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts, now);
  const depth = Object.values(snapshot.depthByLane).reduce((total, count) => total + count, 0);
  return {
    depthByLane: snapshot.depthByLane,
    depth,
    oldestUnclaimedMs: snapshot.oldestUnclaimedMs,
    exhausted: snapshot.exhausted,
    p95EnrichmentLagMs: snapshot.p95EnrichmentLagMs,
    deadLetterAttentionCount: countDeadLetterAttention(db, config.operational.workerMaxAttempts),
    cueDegradedRate: snapshot.cueDegradedRate,
    reinforcementDropped: snapshot.reinforcementDropped,
  };
}

/** The model calls the substrate made, summed across every route the router can take. */
export function readGeneration(db: SqliteHandle): GenerationHealth {
  const counters = generationCounters(db);
  return { calls: counters.calls, failed: counters.failed, failureRate: counters.failureRate };
}

async function readEnrichment(
  driver: Driver,
  db: SqliteHandle,
  scanLimit: number,
): Promise<EnrichmentHealth> {
  const report = await reconcileEnrichment(driver, db, { limit: scanLimit });
  return {
    episodes: report.episodes,
    unenriched: report.unenriched,
    queued: report.queued,
    truncated: report.truncated,
  };
}

async function readRedaction(
  driver: Driver,
  config: Config,
  residueLimit: number,
): Promise<RedactionHealth> {
  const residue = await scanRedactionResidue(
    driver,
    config.redaction.entropyThreshold,
    residueLimit,
  );
  return { scanned: residue.scanned, leaking: residue.leaking };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Age rather than count. Two open proposals a week old and two hundred opened this morning are
 * the same number and opposite situations: one is a queue nobody works, the other is a queue
 * doing its job.
 */
function readProposals(db: SqliteHandle, now: Date): ProposalHealth {
  const supersession = listOpenSupersessionProposalCreatedAt(db);
  const merges = listOpenEntityMergeProposalCreatedAt(db);
  const ages = [...supersession, ...merges].map((createdAt) =>
    Math.max(0, now.getTime() - new Date(createdAt).getTime()),
  );
  return {
    supersessionOpen: supersession.length,
    entityMergeOpen: merges.length,
    // A reduce rather than `Math.max(...ages)`: the spread passes one argument per open row,
    // which a large queue turns into a call the engine refuses.
    oldestOpenAgeMs:
      ages.length === 0 ? undefined : ages.reduce((oldest, age) => Math.max(oldest, age), 0),
    medianOpenAgeMs: median(ages),
  };
}

/**
 * What the deterministic sweep has left to do, read from the graph. The proposal queue cannot
 * answer this: since the cascade shipped, that queue holds only pairs a judge split on, and the
 * sweep merges spellings no judge was ever asked about.
 */
async function readEntities(driver: Driver, scanLimit: number): Promise<EntityHealth> {
  const [tier0Eligible, namings] = await Promise.all([
    countTier0EligibleEntities(driver, { limit: scanLimit }),
    readCurrentEntityNamings(driver, scanLimit),
  ]);
  const identifierShaped = namings.filter(
    (naming) => identifierShape(naming.name) !== 'none',
  ).length;
  return { tier0Eligible, identifierShaped };
}

function readPlasticity(db: SqliteHandle): PlasticityHealth {
  const counters = plasticityCounters(db);
  return {
    reinforcementQueueDepth: counters.reinforcementQueueDepth,
    reinforcementLastRunAt: counters.reinforcement.lastRunAt,
    decayLastRunAt: counters.decay.lastRunAt,
  };
}

/**
 * Effectiveness is improved runs over the runs a declared metric scored, and it is undefined
 * wherever that denominator is zero: an operation that declares no metric, and an operation that
 * declares one but has not resolved a run against it yet. Undefined is the reading, not a
 * missing one. An operation with no metric can only ever be scored on whether it did something,
 * which is a verdict its own run decides, and a loop that weights operations on that is
 * measuring the operation's willingness rather than its effect.
 *
 * `runs` still counts every resolution, unmeasured ones included, so waiting time and the
 * has-it-ever-run gates read the same number they always did.
 */
export function readOperationEffectiveness(
  db: SqliteHandle,
  operations: readonly OperationMeasurement[],
  cycle: number,
): readonly OperationEffectiveness[] {
  const measured = new Set(
    operations.filter((operation) => operation.measured).map((operation) => operation.name),
  );
  return listOperationStats(
    db,
    operations.map((operation) => operation.name),
  ).map((stats) => {
    const scored = stats.runs - stats.unmeasured;
    return {
      name: stats.name,
      runs: stats.runs,
      improved: stats.improved,
      failed: stats.failed,
      effectiveness: measured.has(stats.name) && scored > 0 ? stats.improved / scored : undefined,
      cyclesSinceSelected: Math.max(0, cycle - (stats.selectedCycle ?? 0)),
      lastRunAt: stats.lastRunAt,
      meanDurationMs: meanOperationDurationMs(stats),
    };
  });
}

export async function observeHealth(
  deps: ObserveDeps,
  options: ObserveOptions = {},
): Promise<HealthSnapshot> {
  const now = options.now ?? new Date();
  const cycle = options.cycle ?? 0;
  const scanLimit = options.scanLimit ?? DEFAULT_OBSERVE_SCAN_LIMIT;
  const residueLimit = options.residueLimit ?? DEFAULT_OBSERVE_RESIDUE_LIMIT;
  const operations = options.operations ?? [];
  const degraded: string[] = [];

  const [
    graph,
    queue,
    enrichment,
    redaction,
    proposals,
    entities,
    plasticity,
    generation,
    effectiveness,
  ] = await Promise.all([
    collect(HEALTH_COLLECTORS.graph, deps.logger, degraded, NEUTRAL_GRAPH_HEALTH, () =>
      readGraph(deps.driver, scanLimit, deps.config.hebbian.weightFloor),
    ),
    collect(HEALTH_COLLECTORS.queue, deps.logger, degraded, NEUTRAL_QUEUE_HEALTH, () =>
      Promise.resolve(readQueue(deps.db, deps.config, now)),
    ),
    collect(HEALTH_COLLECTORS.enrichment, deps.logger, degraded, NEUTRAL_ENRICHMENT_HEALTH, () =>
      readEnrichment(deps.driver, deps.db, scanLimit),
    ),
    collect(HEALTH_COLLECTORS.redaction, deps.logger, degraded, NEUTRAL_REDACTION_HEALTH, () =>
      readRedaction(deps.driver, deps.config, residueLimit),
    ),
    collect(HEALTH_COLLECTORS.proposals, deps.logger, degraded, NEUTRAL_PROPOSAL_HEALTH, () =>
      Promise.resolve(readProposals(deps.db, now)),
    ),
    collect(HEALTH_COLLECTORS.entities, deps.logger, degraded, NEUTRAL_ENTITY_HEALTH, () =>
      readEntities(deps.driver, scanLimit),
    ),
    collect(HEALTH_COLLECTORS.plasticity, deps.logger, degraded, NEUTRAL_PLASTICITY_HEALTH, () =>
      Promise.resolve(readPlasticity(deps.db)),
    ),
    collect(HEALTH_COLLECTORS.generation, deps.logger, degraded, NEUTRAL_GENERATION_HEALTH, () =>
      Promise.resolve(readGeneration(deps.db)),
    ),
    collect(
      HEALTH_COLLECTORS.effectiveness,
      deps.logger,
      degraded,
      [] as readonly OperationEffectiveness[],
      () => Promise.resolve(readOperationEffectiveness(deps.db, operations, cycle)),
    ),
  ]);

  return {
    observedAt: now.toISOString(),
    cycle,
    graph,
    queue,
    enrichment,
    redaction,
    proposals,
    entities,
    plasticity,
    generation,
    effectiveness,
    degraded,
  };
}

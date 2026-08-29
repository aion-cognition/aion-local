import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import { countGraphElements } from '../../infrastructure/graph/introspection.js';
import {
  countEpisodesWithoutSession,
  countOrphanNodes,
  countVectorParity,
} from '../../infrastructure/graph/introspection-health.js';
import { findStaleNarratives } from '../../infrastructure/graph/narrative-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listEntityMergeProposals } from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { listOperationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { listSupersessionProposals } from '../../infrastructure/sqlite/supersession-proposals.js';
import { plasticityCounters } from '../../plasticity/application/metrics.js';
import { scanRedactionResidue } from '../../redaction/residue.js';
import { queueLagSnapshot } from '../../reflection/application/lag.js';
import { reconcileEnrichment } from '../../reflection/application/reconcile.js';
import { NARRATIVE_GROUNDING } from '../../reflection/domain/narrative.js';
import {
  HEALTH_COLLECTORS,
  NEUTRAL_ENRICHMENT_HEALTH,
  NEUTRAL_GRAPH_HEALTH,
  NEUTRAL_PLASTICITY_HEALTH,
  NEUTRAL_PROPOSAL_HEALTH,
  NEUTRAL_QUEUE_HEALTH,
  NEUTRAL_REDACTION_HEALTH,
  parityRatio,
  share,
  type EnrichmentHealth,
  type GraphStructureHealth,
  type HealthSnapshot,
  type OperationEffectiveness,
  type PlasticityHealth,
  type ProposalHealth,
  type QueueHealth,
  type RedactionHealth,
} from '../domain/health.js';

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
  /** Registered operation names, so an operation with no history still appears with a zeroed record. */
  readonly operationNames?: readonly string[];
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
): Promise<GraphStructureHealth> {
  const [counts, parity, orphans, missing, stale] = await Promise.all([
    countGraphElements(driver),
    countVectorParity(driver, scanLimit),
    countOrphanNodes(driver, scanLimit),
    countEpisodesWithoutSession(driver, scanLimit),
    findStaleNarratives(driver, NARRATIVE_GROUNDING, scanLimit),
  ]);
  return {
    nodes: counts.nodes,
    relationships: counts.relationships,
    vectorExpected: parity.expected,
    vectorPresent: parity.vectored,
    vectorParity: parityRatio(parity.vectored, parity.expected),
    orphanNodes: orphans.orphans,
    orphanShare: share(orphans.orphans, orphans.nodes),
    episodesWithoutSession: missing,
    staleNarratives: stale.length,
  };
}

function readQueue(db: SqliteHandle, config: Config, now: Date): QueueHealth {
  const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts, now);
  const depth = Object.values(snapshot.depthByLane).reduce((total, count) => total + count, 0);
  return {
    depthByLane: snapshot.depthByLane,
    depth,
    oldestUnclaimedMs: snapshot.oldestUnclaimedMs,
    exhausted: snapshot.exhausted,
    p95EnrichmentLagMs: snapshot.p95EnrichmentLagMs,
  };
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
  const supersession = listSupersessionProposals(db).filter(
    (proposal) => proposal.resolvedAt === null,
  );
  const merges = listEntityMergeProposals(db).filter((proposal) => proposal.resolvedAt === null);
  const ages = [...supersession, ...merges].map((proposal) =>
    Math.max(0, now.getTime() - new Date(proposal.createdAt).getTime()),
  );
  return {
    supersessionOpen: supersession.length,
    entityMergeOpen: merges.length,
    oldestOpenAgeMs: ages.length === 0 ? undefined : Math.max(...ages),
    medianOpenAgeMs: median(ages),
  };
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
 * Effectiveness is improved runs over resolved runs, and an operation that has never resolved
 * a run reads as 1. A new operation starts trusted and earns its way down: the alternative
 * starts it at zero, where the effectiveness floor holds it under the urgency threshold until
 * starvation protection eventually runs it, which is a slow start nothing asked for.
 */
export function readOperationEffectiveness(
  db: SqliteHandle,
  names: readonly string[],
  cycle: number,
): readonly OperationEffectiveness[] {
  return listOperationStats(db, names).map((stats) => ({
    name: stats.name,
    runs: stats.runs,
    improved: stats.improved,
    failed: stats.failed,
    effectiveness: stats.runs === 0 ? 1 : stats.improved / stats.runs,
    cyclesSinceSelected: Math.max(0, cycle - (stats.selectedCycle ?? 0)),
    lastRunAt: stats.lastRunAt,
  }));
}

export async function observeHealth(
  deps: ObserveDeps,
  options: ObserveOptions = {},
): Promise<HealthSnapshot> {
  const now = options.now ?? new Date();
  const cycle = options.cycle ?? 0;
  const scanLimit = options.scanLimit ?? DEFAULT_OBSERVE_SCAN_LIMIT;
  const residueLimit = options.residueLimit ?? DEFAULT_OBSERVE_RESIDUE_LIMIT;
  const names = options.operationNames ?? [];
  const degraded: string[] = [];

  const [graph, queue, enrichment, redaction, proposals, plasticity, effectiveness] =
    await Promise.all([
      collect(HEALTH_COLLECTORS.graph, deps.logger, degraded, NEUTRAL_GRAPH_HEALTH, () =>
        readGraph(deps.driver, scanLimit),
      ),
      collect(HEALTH_COLLECTORS.queue, deps.logger, degraded, NEUTRAL_QUEUE_HEALTH, () =>
        Promise.resolve(readQueue(deps.db, deps.config, now)),
      ),
      collect(
        HEALTH_COLLECTORS.enrichment,
        deps.logger,
        degraded,
        NEUTRAL_ENRICHMENT_HEALTH,
        () => readEnrichment(deps.driver, deps.db, scanLimit),
      ),
      collect(HEALTH_COLLECTORS.redaction, deps.logger, degraded, NEUTRAL_REDACTION_HEALTH, () =>
        readRedaction(deps.driver, deps.config, residueLimit),
      ),
      collect(HEALTH_COLLECTORS.proposals, deps.logger, degraded, NEUTRAL_PROPOSAL_HEALTH, () =>
        Promise.resolve(readProposals(deps.db, now)),
      ),
      collect(HEALTH_COLLECTORS.plasticity, deps.logger, degraded, NEUTRAL_PLASTICITY_HEALTH, () =>
        Promise.resolve(readPlasticity(deps.db)),
      ),
      collect(
        'effectiveness',
        deps.logger,
        degraded,
        [] as readonly OperationEffectiveness[],
        () => Promise.resolve(readOperationEffectiveness(deps.db, names, cycle)),
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
    plasticity,
    effectiveness,
    degraded,
  };
}

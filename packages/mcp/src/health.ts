import type { PlasticityCounters, QueueLagSnapshot } from '@aion/core';

import { DESCRIPTIONS_VERSION } from './descriptions.js';

/**
 * The `/health` body, assembled away from the request path so the whole liveness surface reads
 * in one place. Every source here is in-process or SQLite-only, with no Neo4j and no Ollama,
 * which is what lets a probe answer on every interval without touching the graph or the model.
 */

export type HealthSources = {
  readonly sessions: number;
  /**
   * Undefined for a service constructed without the dependency, which is what every
   * construction that predates these fields gets: they are omitted rather than reported empty.
   */
  readonly queueLag: (() => QueueLagSnapshot) | undefined;
  readonly plasticity: (() => PlasticityCounters) | undefined;
};

/**
 * Flat, snake_case keys alongside `/health`'s existing ones. Depth is per lane rather
 * than a bare total, since a starved interactive lane behind a bulk flood and an
 * evenly-loaded queue report the same total but need opposite responses.
 */
function queueLagFields(queueLag: (() => QueueLagSnapshot) | undefined): Record<string, unknown> {
  if (queueLag === undefined) {
    return {};
  }
  const snapshot = queueLag();
  return {
    queue_depth: snapshot.depthByLane,
    queue_oldest_unclaimed_ms: snapshot.oldestUnclaimedMs ?? null,
    queue_exhausted: snapshot.exhausted,
    reinforcement_dropped: snapshot.reinforcementDropped,
    enrichment_lag_p95_ms: snapshot.p95EnrichmentLagMs ?? null,
    cue_degraded_rate: snapshot.cueDegradedRate ?? null,
    supersession_proposals_open: snapshot.supersessionProposalsOpen,
    entity_merge_proposals_open: snapshot.entityMergeProposalsOpen,
  };
}

/**
 * Reinforcement and decay counters plus the reinforcement queue depth. The edge-weight
 * distribution is graph-bound and stays out of `/health` on purpose; `aion status` is where it
 * belongs. `reinforcement_dropped` is not repeated here: it is already one of
 * `queueLagFields`'s keys, read from the same counter.
 */
function plasticityFields(
  plasticity: (() => PlasticityCounters) | undefined,
): Record<string, unknown> {
  if (plasticity === undefined) {
    return {};
  }
  const counters = plasticity();
  return {
    reinforcement_signals_applied: counters.reinforcement.signalsApplied,
    reinforcement_pairs_applied: counters.reinforcement.pairsApplied,
    reinforcement_edges_updated: counters.reinforcement.edgesUpdated,
    reinforcement_last_run_at: counters.reinforcement.lastRunAt ?? null,
    reinforcement_queue_depth: counters.reinforcementQueueDepth,
    decay_edges_scanned: counters.decay.edgesScanned,
    decay_edges_decayed: counters.decay.edgesDecayed,
    decay_last_run_at: counters.decay.lastRunAt ?? null,
  };
}

export function healthPayload(sources: HealthSources): Record<string, unknown> {
  return {
    status: 'ok',
    sessions: sources.sessions,
    descriptions_version: DESCRIPTIONS_VERSION,
    build_sha: process.env.AION_BUILD_SHA ?? 'unstamped',
    ...queueLagFields(sources.queueLag),
    ...plasticityFields(sources.plasticity),
  };
}

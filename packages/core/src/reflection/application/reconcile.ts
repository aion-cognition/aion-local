import type { Driver } from 'neo4j-driver';
import { listStoredEpisodes, type StoredEpisodeRef } from '../../infrastructure/graph/episodes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listLedgerKeys } from '../../infrastructure/sqlite/ops-ledger.js';
import { enqueueReflectionJob, listReflectionJobs } from '../../infrastructure/sqlite/reflection-queue.js';
import { INTEGRATE_JOB_TYPE } from './intake.js';
import { orchestratorLedgerKey } from './orchestrator.js';

/**
 * Episodes the substrate stored and will never enrich: no orchestrator ledger key, and no
 * queue row to produce one. Nothing joins the graph against the queue, so this state was
 * invisible — `aion doctor` passed 8 of 8 checks with 95% of episodes in it, and a purge of
 * the queue looked exactly like silent data loss from the outside.
 *
 * The re-enqueue is safe to repeat. Enrichment is ledger-gated per run and per stage, so a
 * job for an episode that has in fact been enriched costs one claim and does no work.
 */

/** One pass reads this many episodes. Above it the answer is "the backlog", not a number. */
export const DEFAULT_RECONCILE_LIMIT = 20_000;

const LEDGER_PREFIX = orchestratorLedgerKey('');

export type ReconcileOptions = {
  readonly limit?: number;
  /** Without it the pass is a count; with it every unenriched episode gets a bulk-lane job. */
  readonly reEnqueue?: boolean;
};

export type ReconcileReport = {
  readonly episodes: number;
  readonly enriched: number;
  readonly queued: number;
  /** Stored, not enriched, and not queued: the ones nothing will ever pick up. */
  readonly unenriched: number;
  readonly reEnqueued: number;
  /** True when `limit` cut the scan, so the counts are a floor rather than the whole substrate. */
  readonly truncated: boolean;
};

function queuedEpisodeIds(db: SqliteHandle): ReadonlySet<string> {
  const queued = new Set<string>();
  for (const job of listReflectionJobs(db)) {
    if (job.jobType !== INTEGRATE_JOB_TYPE) {
      continue;
    }
    const episodeId = (job.payload as { episode_id?: unknown } | null | undefined)?.episode_id;
    if (typeof episodeId === 'string' && episodeId !== '') {
      queued.add(episodeId);
    }
  }
  return queued;
}

function appliedEpisodeIds(db: SqliteHandle): ReadonlySet<string> {
  const applied = new Set<string>();
  for (const key of listLedgerKeys(db, LEDGER_PREFIX)) {
    applied.add(key.slice(LEDGER_PREFIX.length));
  }
  return applied;
}

/**
 * Both sides are read once into sets rather than queried per episode: the state this exists
 * to find is thousands of episodes against thousands of queue rows, and a lookup per pair is
 * the shape that makes the operator reach for raw SQL instead.
 */
export async function reconcileEnrichment(
  driver: Driver,
  db: SqliteHandle,
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  const episodes = await listStoredEpisodes(driver, limit);
  const applied = appliedEpisodeIds(db);
  const queued = queuedEpisodeIds(db);

  const orphaned: StoredEpisodeRef[] = [];
  let enriched = 0;
  let stillQueued = 0;
  for (const episode of episodes) {
    if (applied.has(episode.id)) {
      enriched += 1;
      continue;
    }
    if (queued.has(episode.id)) {
      stillQueued += 1;
      continue;
    }
    orphaned.push(episode);
  }

  let reEnqueued = 0;
  if (options.reEnqueue === true) {
    for (const episode of orphaned) {
      // Bulk: a backfill of episodes that have already waited is exactly what must not push
      // ahead of the turn an agent is having right now.
      enqueueReflectionJob(
        db,
        INTEGRATE_JOB_TYPE,
        { episode_id: episode.id },
        { lane: 'bulk', ...(episode.sessionId === undefined ? {} : { sessionId: episode.sessionId }) },
      );
      reEnqueued += 1;
    }
  }

  return {
    episodes: episodes.length,
    enriched,
    queued: stillQueued,
    unenriched: orphaned.length,
    reEnqueued,
    truncated: episodes.length >= limit,
  };
}

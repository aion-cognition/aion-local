import { runSourceIndexJob, type SourceIndexDeps } from './source-index.js';
import { ReflectionQueueClaimant } from '../../infrastructure/sqlite/claim.js';
import {
  REFLECTION_QUEUE_EPISODE_FIELD,
  type ReflectionJob,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { SOURCE_INDEX_JOB_TYPE } from '../../reflection/application/intake-queue.js';

/**
 * The lease side of the indexing handler: it claims the rows intake wrote and runs them.
 *
 * The reflection worker narrows its own claim to the jobs it can run, so these rows sit
 * untouched until something asks for them. This is that something. It is a drain rather than a
 * loop with a timer: indexing has no freshness pin, the obligation is durable, and a source
 * whose index is incomplete is already held against eviction by the pin the projection carries.
 */

/**
 * Batches one claimed job may run before the row goes back to the queue. A source with more
 * parts than this keeps its cursor and its row, so the next drain resumes where this one
 * stopped rather than starting the source again.
 */
const MAX_BATCHES_PER_JOB = 8;

export type SourceIndexDrainOptions = {
  /** Rows this drain may claim. A drain that claims nothing returns zero of everything. */
  readonly maxJobs?: number;
  readonly maxAttempts?: number;
  /** Rows the caller released and still owes a wait on. They are not claimed at all. */
  readonly skipJobIds?: readonly string[];
};

export type SourceIndexDrain = {
  readonly claimed: number;
  readonly completed: number;
  readonly documents: number;
  /** Jobs returned to the queue with their obligation intact. */
  readonly deferred: number;
  /**
   * Which rows those were, so the caller can hold each one's own backoff. Absent from a caller
   * that reports counts alone.
   */
  readonly deferredJobIds?: readonly string[];
};

function sourceIdOf(job: ReflectionJob): string | undefined {
  if (job.episodeId !== null && job.episodeId !== '') {
    return job.episodeId;
  }
  const payload = job.payload as Record<string, unknown> | null | undefined;
  const stored = payload?.[REFLECTION_QUEUE_EPISODE_FIELD];
  return typeof stored === 'string' && stored !== '' ? stored : undefined;
}

/**
 * Claims and runs the source-index rows, and says what it did. A job whose source cannot be
 * read or whose capability is missing goes back to the queue with the reason on the row: the
 * work is still owed, and the row is the durable statement that it is.
 */
export async function drainSourceIndexQueue(
  deps: SourceIndexDeps,
  options: SourceIndexDrainOptions = {},
): Promise<SourceIndexDrain> {
  const claimant = new ReflectionQueueClaimant();
  const maxJobs = options.maxJobs ?? Number.MAX_SAFE_INTEGER;
  // Every row this drain will run is claimed before any of it runs. A released row is
  // claimable again the instant it is released, so claiming inside the run loop would hand a
  // deferred job straight back to the same drain and spin on it.
  const jobs: ReflectionJob[] = [];
  const skip = options.skipJobIds ?? [];
  while (jobs.length < maxJobs) {
    const job = claimant.claimNext(deps.db, options.maxAttempts, [SOURCE_INDEX_JOB_TYPE], skip);
    if (job === undefined) {
      break;
    }
    jobs.push(job);
  }

  let completed = 0;
  let documents = 0;
  const deferredJobIds: string[] = [];
  for (const job of jobs) {
    const sourceId = sourceIdOf(job);
    if (sourceId === undefined) {
      claimant.release(deps.db, job.id, 'source index job names no source');
      deferredJobIds.push(job.id);
      continue;
    }
    let done = false;
    let reason = 'index incomplete; more parts owed';
    for (let batch = 0; batch < MAX_BATCHES_PER_JOB && !done; batch += 1) {
      const outcome = await runSourceIndexJob(deps, { sourceId });
      if (outcome.status !== 'indexed') {
        reason =
          outcome.status === 'search_unavailable'
            ? `search capability unavailable: ${outcome.cause}`
            : 'source could not be read for indexing';
        break;
      }
      documents += outcome.documents;
      done = outcome.complete;
    }
    if (done) {
      claimant.complete(deps.db, job.id);
      completed += 1;
      continue;
    }
    claimant.release(deps.db, job.id, reason);
    deferredJobIds.push(job.id);
  }
  return {
    claimed: jobs.length,
    completed,
    documents,
    deferred: deferredJobIds.length,
    deferredJobIds,
  };
}

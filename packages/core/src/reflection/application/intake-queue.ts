import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  enqueueReflectionJob,
  findPendingJobForEpisode,
  REFLECTION_QUEUE_EPISODE_FIELD,
} from '../../infrastructure/sqlite/reflection-queue.js';

/** The one job the reflection worker runs off an accepted source. */
export const INTAKE_JOB_TYPE = 'integrate';

/**
 * The bounded source-index work an acceptance owes. The enqueue is the acceptance effect and
 * nothing more; indexing finishes under its own handler later. The row carries the original
 * logical source id and never enters the extraction pipeline.
 */
export const SOURCE_INDEX_JOB_TYPE = 'source_index';

/**
 * The embedding an accepted source owes.
 *
 * It is a queue row rather than the tail of the intake call because embedding is a network call
 * to another process, and a caller that has already been told its experience is stored has no
 * reason to wait on one. Until the row runs, the episode is reachable by BM25, entity
 * resolution, recency and traversal: it is ranking that is missing, not the memory, and recall
 * says so where it serves one.
 */
export const VECTOR_JOB_TYPE = 'attach_vectors';

export type QueuedAcceptance = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly lane: string | null;
  readonly indexPolicy: string;
  readonly acceptedAt: string;
};

function indexWorkKey(sourceId: string, indexPolicy: string): string {
  return `${SOURCE_INDEX_JOB_TYPE}:${sourceId}:${indexPolicy}`;
}

/**
 * The three queue rows an acceptance owes, all written in the acknowledgment transaction.
 *
 * The integrate job is what the reflection worker runs. The vector job rides the acceptance's own
 * lane, because an interactive turn wants its vectors in seconds and a bulk import does not get
 * to push ahead of one, and it is written first so its `lane_seq` puts it ahead of the pipeline
 * run for the same source: entity resolution reads those vectors, and the worker's startup drain
 * orders the two the same way for the same reason. The source-index job belongs to the indexing
 * handler and is enqueued in the bulk lane, so it never counts against the depth an interactive
 * caller is told about. Each is looked up before it is written, so a recovery that reaches this
 * step twice finds the row it already wrote.
 */
export function enqueueSourceWork(
  db: SqliteHandle,
  data: QueuedAcceptance,
  operationId: string,
): void {
  const lane = data.lane === 'bulk' ? 'bulk' : 'interactive';
  if (findPendingJobForEpisode(db, VECTOR_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      VECTOR_JOB_TYPE,
      { [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId },
      {
        lane,
        sessionId: data.sessionId,
        episodeId: data.sourceId,
        now: new Date(data.acceptedAt),
      },
    );
  }
  if (findPendingJobForEpisode(db, INTAKE_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      INTAKE_JOB_TYPE,
      { [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId },
      {
        lane,
        sessionId: data.sessionId,
        episodeId: data.sourceId,
        now: new Date(data.acceptedAt),
      },
    );
  }
  if (findPendingJobForEpisode(db, SOURCE_INDEX_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      SOURCE_INDEX_JOB_TYPE,
      {
        [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId,
        index_policy: data.indexPolicy,
        work_key: indexWorkKey(data.sourceId, data.indexPolicy),
        operation_id: operationId,
      },
      {
        lane: 'bulk',
        sessionId: data.sessionId,
        episodeId: data.sourceId,
        now: new Date(data.acceptedAt),
      },
    );
  }
}

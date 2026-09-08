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
 * The two queue rows an acceptance owes, both written in the acknowledgment transaction.
 *
 * The integrate job is what the reflection worker runs. The source-index job belongs to the
 * indexing handler and is enqueued in the bulk lane, so it never counts against the depth an
 * interactive caller is told about. Both are looked up before they are written, so a recovery that reaches this step twice
 * finds the row it already wrote.
 */
export function enqueueSourceWork(
  db: SqliteHandle,
  data: QueuedAcceptance,
  operationId: string,
): void {
  if (findPendingJobForEpisode(db, INTAKE_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      INTAKE_JOB_TYPE,
      { [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId },
      {
        lane: data.lane === 'bulk' ? 'bulk' : 'interactive',
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

import type { ChunkPublishReport } from './chunk-narrative.js';
import { chunkBlockPrerequisiteMoved, RECONSIDERABLE_REASONS } from './chunk-reconsider.js';
import { blockedAttempts } from '../../infrastructure/sqlite/chunk-blocks.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  advanceNarrativeMigration,
  type NarrativeMigrationJob,
} from '../../infrastructure/sqlite/narrative-migration-job.js';
import {
  recordMigrationIssue,
  recordMigrationRetryFailure,
} from '../../infrastructure/sqlite/narrative-migration-pass.js';
import { holdNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-state.js';
import {
  CHUNK_REVISION_FAMILY,
  clearRevisionBlock,
  deferRevisionAttempt,
  readNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import {
  sealRetryDelayMs,
  MIGRATION_PUBLICATION_FAILURE_LIMIT,
} from '../domain/narrative-retry.js';

/** The cadence dates failures; a prerequisite block still requires evidence of change. */
export function scheduleMigrationPublicationRetry(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  result: ChunkPublishReport,
  now: Date,
): 'publication_retry_wait' | 'publication_retry_exhausted' | undefined {
  if (result.status !== 'failed' && result.status !== 'deferred') {
    return undefined;
  }
  const failures = recordMigrationRetryFailure(db, job, result.chunkId, result.reason);
  if (failures === undefined) {
    return undefined;
  }
  if (failures >= MIGRATION_PUBLICATION_FAILURE_LIMIT) {
    holdNarrativeMigration(db, job, 'publication_retry_exhausted', now);
    return 'publication_retry_exhausted';
  }
  if (result.revisionNo === 0) {
    advanceNarrativeMigration(
      db,
      job,
      job.phase,
      job.cursor,
      now,
      new Date(now.getTime() + sealRetryDelayMs(1)),
    );
    return 'publication_retry_wait';
  }
  const row = readNarrativeRevision(db, CHUNK_REVISION_FAMILY, result.chunkId, result.revisionNo);
  if (row?.state === 'allocated' && row.blockedReason === null) {
    deferRevisionAttempt(
      db,
      CHUNK_REVISION_FAMILY,
      result.chunkId,
      result.revisionNo,
      new Date(now.getTime() + sealRetryDelayMs(row.attempts)),
    );
  }
  return undefined;
}

/** Blocked revision attempts inspected for one session, independently of the session's chunk count. */
const MIGRATION_RECONSIDER_ATTEMPTS = 128;

/** Reconsiders only this cohort's session, using the same prerequisite rule as steady-state sealing. */
export function reconsiderMigrationSession(
  db: SqliteHandle,
  job: NarrativeMigrationJob,
  sessionId: string,
): void {
  const attempts = blockedAttempts(db, {
    cohortId: job.cohortId,
    sessionId,
    initialOnly: true,
    reasons: RECONSIDERABLE_REASONS,
    limit: MIGRATION_RECONSIDER_ATTEMPTS + 1,
  });
  if (attempts.length > MIGRATION_RECONSIDER_ATTEMPTS) {
    recordMigrationIssue(db, job, sessionId, 'blocked_attempt_scan_bound');
    return;
  }
  for (const attempt of attempts) {
    if (chunkBlockPrerequisiteMoved(db, attempt, { ...job.policy })) {
      clearRevisionBlock(db, CHUNK_REVISION_FAMILY, attempt.chunkId, attempt.revisionNo);
    }
  }
}

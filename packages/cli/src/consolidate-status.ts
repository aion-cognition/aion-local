import {
  describeError,
  openReadOnlySqliteHandle,
  readNarrativeMigration,
  readMigrationIssues,
  sqliteTableExists,
} from '@aion/core';
import { statSync } from 'node:fs';

import type { Writer } from './output.js';

export type MigrationStatusReading =
  | {
      readonly status: 'read';
      readonly job: NonNullable<ReturnType<typeof readNarrativeMigration>>;
      readonly problems?: ReturnType<typeof readMigrationIssues>;
    }
  | {
      readonly status: 'missing';
      readonly reason: 'store_missing' | 'schema_missing' | 'job_missing';
      readonly job: null;
    }
  | { readonly status: 'unavailable'; readonly reason: string; readonly job: null };

/** Status does not create a database, initialize schema, or turn an unreadable store into an empty one. */
export function inspectMigration(path: string, cohortId: string): MigrationStatusReading {
  try {
    statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', reason: 'store_missing', job: null };
    }
    return { status: 'unavailable', reason: describeError(error), job: null };
  }
  try {
    const db = openReadOnlySqliteHandle({ filePath: path });
    try {
      if (!sqliteTableExists(db, 'narrative_migration_jobs')) {
        return { status: 'missing', reason: 'schema_missing', job: null };
      }
      const job = readNarrativeMigration(db, cohortId);
      return job === undefined
        ? { status: 'missing', reason: 'job_missing', job: null }
        : {
            status: 'read',
            job,
            ...(sqliteTableExists(db, 'narrative_migration_issues')
              ? { problems: readMigrationIssues(db, cohortId) }
              : {}),
          };
    } finally {
      db.close();
    }
  } catch (error) {
    return { status: 'unavailable', reason: describeError(error), job: null };
  }
}

export function writeMigrationStatus(
  reading: MigrationStatusReading,
  json: boolean,
  write: Writer,
): void {
  if (reading.status !== 'read') {
    write(json ? JSON.stringify(reading) : `migration ${reading.status}: ${reading.reason}`);
    return;
  }
  const { job } = reading;
  if (json) {
    write(JSON.stringify({ status: job.state, job, ...reading.problems }));
    return;
  }
  write(`${job.cohortId}: ${job.state}, ${job.phase}, checkpoint ${String(job.revision)}`);
  write(
    `frozen policy v${String(job.policy.partitionPolicyVersion)}: ${String(job.policy.maxMembers)} members, ${String(job.policy.renderedInputAllowance)} rendered units, span ${String(job.policy.maxSpanMs)} ms`,
  );
  if (job.retryAt !== undefined) {
    write(`next attempt: ${job.retryAt}`);
  }
  for (const issue of reading.problems?.issues ?? []) {
    write(`${issue.id}: ${issue.reason}`);
  }
  if (reading.problems?.issuesTruncated) {
    write('further issues are recorded; this status page is bounded');
  }
  if (job.blockedReason !== undefined) {
    write(`blocked: ${job.blockedReason}`);
    if (job.blockedReason === 'capture_member_bound') {
      write(
        'This capture exceeds the fixed cohort bound; abandon this job to release its reservation. Refresh cannot increase that bound.',
      );
      write(`aion consolidate abandon --cohort ${job.cohortId}`);
    }
  }
}

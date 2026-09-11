import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { publishChunkNarrative } from './chunk-narrative.js';
import type { ChunkNarrativeDeps } from './chunk-seal.js';
import { runLegacyBackfillBatch } from './legacy-backfill.js';
import { scheduleMigrationPublicationRetry } from './migration-publication.js';
import { inventoryLegacyNarrative } from './narrative-family.js';
import { migrateSessionStep } from './narrative-migration-session.js';
import { describeError } from '../../infrastructure/errors.js';
import { pageLegacyEpisodeCensus } from '../../infrastructure/graph/legacy-evidence-queries.js';
import { pageLegacyNarrativeIdentities } from '../../infrastructure/graph/narrative-families.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { pageArchiveRows } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  countMigrationProgress,
  readMigrationCohort,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import type { MigrationPartitionPolicy } from '../../infrastructure/sqlite/migration-partition.js';
import {
  advanceNarrativeMigration,
  beginNarrativeMigration,
  captureNarrativeMigrationPage,
  countCapturedMigrationSources,
  freezeNarrativeMigrationCapture,
  readNarrativeMigration,
  type NarrativeMigrationJob,
} from '../../infrastructure/sqlite/narrative-migration-job.js';
import {
  recordMigrationIssue,
  readMigrationIssues,
  beginMigrationPass,
  holdRepeatedCensusRefusal,
} from '../../infrastructure/sqlite/narrative-migration-pass.js';
import {
  migrationRemainders,
  nextMigrationChunk,
  nextMigrationSource,
} from '../../infrastructure/sqlite/narrative-migration-read.js';
import { refreshNarrativeMigration } from '../../infrastructure/sqlite/narrative-migration-state.js';

/** Each limit belongs to one batch or one existing domain operation, never to an unbounded retry loop. */
export const NARRATIVE_MIGRATION_LIMITS = {
  steps: 16,
  page: 32,
  relations: 500,
  batchWallMs: 5000,
} as const;

export type NarrativeMigrationOptions = {
  readonly cohortId: string;
  readonly policy: MigrationPartitionPolicy;
  readonly now: Date;
  readonly steps?: number;
  readonly pageSize?: number;
  readonly relationLimit?: number;
  readonly batchWallMs?: number;
  readonly signal?: AbortSignal;
  /** Explicitly re-prove the frozen sources; assignments and the first saved order remain immutable. */
  readonly refresh?: boolean;
  /** The indexer owns reindex policy; this bounded hook is called only after a verified source check. */
  readonly onVerifiedSource?: (sourceId: string, cohortId: string) => Promise<void>;
};

export type NarrativeMigrationReport = {
  readonly cohortId: string;
  readonly phase: NarrativeMigrationJob['phase'];
  readonly complete: boolean;
  readonly state: NarrativeMigrationJob['state'];
  readonly retryAt?: string;
  readonly steps: number;
  readonly verifiedOutcomes: number;
  readonly sealed: number;
  readonly published: number;
  readonly cutovers: number;
  readonly cohort:
    | { readonly status: 'capturing'; readonly captured: number }
    | {
        readonly status: 'frozen';
        readonly accounted: number;
        readonly verified: number;
        readonly pinned: number;
        readonly partitionGaps: number;
        readonly unassignedSources: number;
        readonly unpublishedChunks: number;
      };
  readonly issues: readonly { readonly id: string; readonly reason: string }[];
  readonly issuesTruncated: boolean;
  readonly stopped?: string;
};

class Counts {
  verifiedOutcomes = 0;
  sealed = 0;
  published = 0;
  cutovers = 0;
  snapshot() {
    return {
      verifiedOutcomes: this.verifiedOutcomes,
      sealed: this.sealed,
      published: this.published,
      cutovers: this.cutovers,
    };
  }
  record(kind: 'verifiedOutcomes' | 'sealed' | 'published' | 'cutovers', amount = 1): void {
    this[kind] += amount;
  }
}

function resumedJob(db: ChunkNarrativeDeps['db'], cohortId: string): NarrativeMigrationJob {
  const job = readNarrativeMigration(db, cohortId);
  if (job === undefined) {
    throw new Error('the saved migration job disappeared');
  }
  return job;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('migration bounds must be positive safe integers');
  }
  return value;
}

function issue(
  deps: ChunkNarrativeDeps,
  job: NarrativeMigrationJob,
  id: string,
  reason: string,
): void {
  recordMigrationIssue(deps.db, job, id, reason);
}

/** One resumable batch. Nothing here resets raw data, prunes intents, or competes with the steady-state scheduler's budget. */
export async function runNarrativeMigrationBatch(
  deps: ChunkNarrativeDeps,
  options: NarrativeMigrationOptions,
): Promise<NarrativeMigrationReport> {
  const limit = positive(options.steps ?? NARRATIVE_MIGRATION_LIMITS.steps);
  const page = positive(options.pageSize ?? NARRATIVE_MIGRATION_LIMITS.page);
  const relations = positive(options.relationLimit ?? NARRATIVE_MIGRATION_LIMITS.relations);
  const deadline = positive(options.batchWallMs ?? NARRATIVE_MIGRATION_LIMITS.batchWallMs);
  let job = readNarrativeMigration(deps.db, options.cohortId);
  if (
    job === undefined ||
    (job.state === 'running' &&
      (job.retryAt === undefined || job.retryAt <= options.now.toISOString())) ||
    (options.refresh && job.state !== 'abandoned' && job.blockedReason !== 'capture_member_bound')
  ) {
    await deps.publications.recover();
    job = beginNarrativeMigration(deps.db, options);
    if (options.refresh) {
      refreshNarrativeMigration(deps.db, job, options.now);
      job = resumedJob(deps.db, options.cohortId);
    }
  }
  const counts = new Counts();
  const started = performance.now();
  let steps = 0;
  let stopped: string | undefined;
  while (steps < limit && job.state === 'running') {
    if (job.retryAt !== undefined && job.retryAt > options.now.toISOString()) {
      stopped = 'publication_retry_wait';
      break;
    }
    if (options.signal?.aborted || performance.now() - started >= deadline) {
      stopped = options.signal?.aborted ? 'aborted' : 'batch_wall_budget';
      break;
    }
    stopped = await step(deps, job, options, { page, relations }, counts);
    steps += 1;
    job = resumedJob(deps.db, options.cohortId);
    if (stopped !== undefined) {
      break;
    }
  }
  if (job.state === 'blocked') {
    stopped = job.blockedReason ?? 'migration_blocked';
  } else if (job.state === 'abandoned') {
    stopped = 'migration_abandoned';
  }
  const cohort =
    readMigrationCohort(deps.db, options.cohortId) === undefined
      ? {
          status: 'capturing' as const,
          captured: countCapturedMigrationSources(deps.db, options.cohortId),
        }
      : {
          status: 'frozen' as const,
          ...countMigrationProgress(deps.db, options.cohortId),
          ...migrationRemainders(deps.db, options.cohortId),
        };
  return {
    cohortId: options.cohortId,
    phase: job.phase,
    complete: job.state === 'complete',
    state: job.state,
    ...(job.retryAt === undefined ? {} : { retryAt: job.retryAt }),
    steps,
    ...counts.snapshot(),
    ...readMigrationIssues(deps.db, job.cohortId),
    cohort,
    ...(stopped === undefined ? {} : { stopped }),
  };
}

async function step(
  deps: ChunkNarrativeDeps,
  job: NarrativeMigrationJob,
  options: NarrativeMigrationOptions,
  limits: { page: number; relations: number },
  counts: Counts,
): Promise<string | undefined> {
  const advance = (phase: NarrativeMigrationJob['phase'], cursor = ''): void => {
    advanceNarrativeMigration(deps.db, job, phase, cursor, options.now);
  };
  if (job.phase === 'archive') {
    const cursor = job.cursor === '' ? 0 : Number(job.cursor);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      (job.cursor !== '' && String(cursor) !== job.cursor)
    ) {
      throw new Error('invalid archive migration cursor');
    }
    const rows = pageArchiveRows(deps.db, {
      low: job.archiveRowidLow,
      high: job.archiveRowidHigh,
      cursor,
      limit: limits.page,
    });
    const last = rows.at(-1);
    if (last === undefined) {
      advance('graph');
    } else {
      captureNarrativeMigrationPage(
        deps.db,
        job,
        rows.map((row) => row.episodeId),
        String(last.rowid),
        options.now,
      );
    }
    return undefined;
  }
  if (job.phase === 'graph') {
    const ids = await pageLegacyEpisodeCensus(deps.driver, job.cursor, limits.page);
    const last = ids.at(-1);
    if (last === undefined) {
      freezeNarrativeMigrationCapture(deps.db, job, options.now);
    } else {
      captureNarrativeMigrationPage(deps.db, job, ids, last, options.now);
    }
    return undefined;
  }
  if (job.phase === 'verify') {
    const sourceId = nextMigrationSource(
      deps.db,
      job.cohortId,
      job.cursor,
      false,
      job.repairResumePhase !== undefined,
    );
    if (sourceId === undefined) {
      advance('order');
      return undefined;
    }
    const result = await runLegacyBackfillBatch(deps, {
      cohortId: job.cohortId,
      now: options.now,
      sourceIds: [sourceId],
      limit: 1,
      reverify: true,
      relationLimit: limits.relations,
    });
    const outcome = result.outcomes[0];
    if (outcome?.published !== 'acknowledged' && outcome?.published !== 'skipped') {
      return outcome?.reason ?? 'source_verification_unavailable';
    }
    if (outcome.status === 'verified') {
      counts.record('verifiedOutcomes');
      try {
        await options.onVerifiedSource?.(sourceId, job.cohortId);
      } catch (error) {
        // The core producer already queued index work. An auxiliary enqueue cannot re-run raw verification.
        issue(deps, job, sourceId, `reindex_hook: ${describeError(error)}`);
      }
    } else {
      issue(deps, job, sourceId, outcome.reason);
    }
    advance('verify', sourceId);
    return undefined;
  }
  if (job.phase === 'order') {
    const sourceId = nextMigrationSource(deps.db, job.cohortId, job.cursor, true);
    if (sourceId === undefined) {
      advance(job.repairResumePhase ?? 'inventory');
      return undefined;
    }
    const coverage = readCurrentCoverageContract(deps.db);
    if (coverage === undefined) {
      return 'coverage_unavailable';
    }
    const outcome = await deps.publications.publish({
      kind: 'migration_order',
      operationId: `migration-order:${randomUUID()}`,
      payload: { cohortId: job.cohortId, sourceId, coverageEpoch: coverage.epoch },
    });
    if (outcome.status !== 'acknowledged') {
      return outcome.reason;
    }
    advance('order', sourceId);
    return undefined;
  }
  if (job.phase === 'census') {
    const outcome = await deps.publications.publish({
      kind: 'legacy_materialization',
      operationId: `migration-census:${randomUUID()}`,
      payload: {
        mode: 'census',
        cohortId: job.cohortId,
        endpointLimit: limits.page,
        relationLimit: limits.relations,
        after: job.cursor,
      },
    });
    if (outcome.status !== 'acknowledged') {
      issue(deps, job, job.cohortId, outcome.reason);
      if (outcome.reason === 'cohort_not_fully_accounted') {
        holdRepeatedCensusRefusal(deps.db, job, options.now);
      }
      return outcome.reason;
    }
    const result = z.object({ cursor: z.string() }).parse(outcome.result);
    if (result.cursor > job.cursor) {
      advance('census', result.cursor);
    } else {
      advance('partition');
    }
    return undefined;
  }
  if (job.phase === 'inventory') {
    const [identity] = await pageLegacyNarrativeIdentities(deps.driver, job.cursor, 1);
    if (identity === undefined) {
      advance('census');
    } else {
      if (identity.sessionId === undefined) {
        issue(deps, job, identity.nodeId, 'legacy_session_unresolved');
      } else {
        const result = await inventoryLegacyNarrative(deps, {
          sessionId: identity.sessionId,
          narrativeId: identity.nodeId,
        });
        if (result.status !== 'acknowledged') {
          issue(deps, job, identity.nodeId, result.reason);
        }
      }
      advance('inventory', identity.nodeId);
    }
    return undefined;
  }
  if (job.phase === 'publish') {
    const chunkId = nextMigrationChunk(deps.db, job.cohortId, job.cursor, options.now);
    if (chunkId === undefined) {
      advance('cutover');
      return undefined;
    }
    const result = await publishChunkNarrative(deps, chunkId, {
      now: options.now,
      policy: job.policy,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.status === 'published') {
      counts.record('published');
    } else if (result.status !== 'skipped') {
      issue(deps, job, chunkId, result.reason);
    }
    if (scheduleMigrationPublicationRetry(deps.db, job, result, options.now)) {
      return 'publication_retry_wait';
    }
    advance('publish', chunkId);
    return undefined;
  }
  if (job.phase === 'partition' && job.cursor === '') {
    beginMigrationPass(deps.db, job);
  }
  return migrateSessionStep(deps, job, options.now, {
    issue: (id, reason) => {
      issue(deps, job, id, reason);
    },
    sealed: (created) => {
      counts.record('sealed', created ? 1 : 0);
    },
    cutover: (changed) => {
      counts.record('cutovers', changed ? 1 : 0);
    },
  });
}

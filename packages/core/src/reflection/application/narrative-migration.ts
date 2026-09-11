import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { publishChunkNarrative } from './chunk-narrative.js';
import { measureChunkCandidates, type ChunkNarrativeDeps } from './chunk-seal.js';
import { runLegacyBackfillBatch } from './legacy-backfill.js';
import {
  cutoverSessionFamily,
  ensureSessionFamily,
  inventoryLegacyNarrative,
} from './narrative-family.js';
import { describeError } from '../../infrastructure/errors.js';
import { pageLegacyEpisodeCensus } from '../../infrastructure/graph/legacy-evidence-queries.js';
import { pageLegacyNarrativeIdentities } from '../../infrastructure/graph/narrative-families.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { pageArchiveRows } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  countMigrationProgress,
  readMigrationCohort,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  listMigrationRemainder,
  sealMigrationMembership,
  type MigrationPartitionPolicy,
} from '../../infrastructure/sqlite/migration-partition.js';
import { readCutoverPartition } from '../../infrastructure/sqlite/migration-session.js';
import {
  advanceNarrativeMigration,
  beginNarrativeMigration,
  captureNarrativeMigrationPage,
  freezeNarrativeMigrationCapture,
  readNarrativeMigration,
  type NarrativeMigrationJob,
} from '../../infrastructure/sqlite/narrative-migration-job.js';
import {
  adoptExistingMigrationChunk,
  chosenMigrationMembers,
  nextMigrationChunk,
  nextMigrationSession,
  nextMigrationSource,
  unassignedOrderedMembers,
  migrationRemainders,
} from '../../infrastructure/sqlite/narrative-migration-read.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import { decideChunkSeal } from '../domain/chunk-boundary.js';

/** Each limit belongs to one batch or one existing domain operation, never to an unbounded retry loop. */
export const NARRATIVE_MIGRATION_LIMITS = {
  steps: 16,
  page: 32,
  relations: 500,
  betweenStepsMs: 5000,
} as const;
const Position = z.strictObject({ sessionId: z.string(), members: z.number().int().nonnegative() });
const Cursor = z.strictObject({ after: Position.optional(), allReady: z.boolean().optional() });

export type NarrativeMigrationOptions = {
  readonly cohortId: string;
  readonly policy: MigrationPartitionPolicy;
  readonly now: Date;
  readonly steps?: number;
  readonly pageSize?: number;
  readonly relationLimit?: number;
  readonly betweenStepsMs?: number;
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
  readonly stopped?: string;
};

class Counts {
  verifiedOutcomes = 0;
  sealed = 0;
  published = 0;
  cutovers = 0;
  readonly issues: { id: string; reason: string }[] = [];
  snapshot() {
    return {
      verifiedOutcomes: this.verifiedOutcomes,
      sealed: this.sealed,
      published: this.published,
      cutovers: this.cutovers,
      issues: this.issues,
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
  counts: Counts,
  id: string,
  reason: string,
): void {
  counts.issues.push({ id, reason });
  markLedgerApplied(deps.db, `narrative-migration:${job.cohortId}:issue:${id}`, {
    phase: job.phase,
    id,
    reason,
  });
}

/** One resumable batch. Nothing here resets raw data, prunes intents, or competes with the steady-state scheduler's budget. */
export async function runNarrativeMigrationBatch(
  deps: ChunkNarrativeDeps,
  options: NarrativeMigrationOptions,
): Promise<NarrativeMigrationReport> {
  const limit = positive(options.steps ?? NARRATIVE_MIGRATION_LIMITS.steps);
  const page = positive(options.pageSize ?? NARRATIVE_MIGRATION_LIMITS.page);
  const relations = positive(options.relationLimit ?? NARRATIVE_MIGRATION_LIMITS.relations);
  const deadline = positive(options.betweenStepsMs ?? NARRATIVE_MIGRATION_LIMITS.betweenStepsMs);
  await deps.publications.recover();
  let job = beginNarrativeMigration(deps.db, options);
  if (options.refresh && job.phase !== 'archive' && job.phase !== 'graph') {
    advanceNarrativeMigration(deps.db, job, 'verify', '', options.now);
    job = resumedJob(deps.db, options.cohortId);
  }
  const counts = new Counts();
  const started = performance.now();
  let steps = 0;
  let stopped: string | undefined;
  while (steps < limit && job.phase !== 'complete') {
    if (options.signal?.aborted || performance.now() - started >= deadline) {
      stopped = options.signal?.aborted ? 'aborted' : 'between_steps_budget';
      break;
    }
    stopped = await step(deps, job, options, { page, relations }, counts);
    steps += 1;
    job = resumedJob(deps.db, options.cohortId);
    if (stopped !== undefined) {
      break;
    }
  }
  const cohort =
    readMigrationCohort(deps.db, options.cohortId) === undefined
      ? {
          status: 'capturing' as const,
          captured: (
            deps.db
              .prepare('SELECT COUNT(*) AS n FROM narrative_migration_capture WHERE cohort_id = ?')
              .get(options.cohortId) as { n: number }
          ).n,
        }
      : {
          status: 'frozen' as const,
          ...countMigrationProgress(deps.db, options.cohortId),
          ...migrationRemainders(deps.db, options.cohortId),
        };
  return {
    cohortId: options.cohortId,
    phase: job.phase,
    complete: job.phase === 'complete',
    steps,
    ...counts.snapshot(),
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
    const sourceId = nextMigrationSource(deps.db, job.cohortId, job.cursor);
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
        issue(deps, job, counts, sourceId, `reindex_hook: ${describeError(error)}`);
      }
    } else {
      issue(deps, job, counts, sourceId, outcome.reason);
    }
    advance('verify', sourceId);
    return undefined;
  }
  if (job.phase === 'order') {
    const sourceId = nextMigrationSource(deps.db, job.cohortId, job.cursor, true);
    if (sourceId === undefined) {
      advance('inventory');
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
        issue(deps, job, counts, identity.nodeId, 'legacy_session_unresolved');
      } else {
        const result = await inventoryLegacyNarrative(deps, {
          sessionId: identity.sessionId,
          narrativeId: identity.nodeId,
        });
        if (result.status !== 'acknowledged') {
          issue(deps, job, counts, identity.nodeId, result.reason);
        }
      }
      advance('inventory', identity.nodeId);
    }
    return undefined;
  }
  if (job.phase === 'publish') {
    const chunkId = nextMigrationChunk(deps.db, job.cohortId, job.cursor);
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
      issue(deps, job, counts, chunkId, result.reason);
    }
    advance('publish', chunkId);
    return undefined;
  }
  return sessionStep(deps, job, options, counts);
}

async function sessionStep(
  deps: ChunkNarrativeDeps,
  job: NarrativeMigrationJob,
  options: NarrativeMigrationOptions,
  counts: Counts,
): Promise<string | undefined> {
  const cursor = Cursor.parse(job.cursor === '' ? {} : JSON.parse(job.cursor));
  const session = nextMigrationSession(deps.db, job.cohortId, cursor.after);
  const advance = (
    phase: NarrativeMigrationJob['phase'],
    next: z.infer<typeof Cursor> = {},
  ): void => {
    advanceNarrativeMigration(deps.db, job, phase, JSON.stringify(next), options.now);
  };
  if (session === undefined) {
    if (job.phase === 'partition') {
      advanceNarrativeMigration(
        deps.db,
        job,
        unassignedOrderedMembers(deps.db, job.cohortId) > 0 ? 'partition' : 'publish',
        '',
        options.now,
      );
    } else {
      advanceNarrativeMigration(
        deps.db,
        job,
        cursor.allReady === false ? 'publish' : 'complete',
        '',
        options.now,
      );
    }
    return undefined;
  }
  if (job.phase === 'partition') {
    const rows = listMigrationRemainder(
      deps.db,
      job.cohortId,
      session.sessionId,
      job.policy.maxMembers + 1,
    );
    const first = rows[0];
    if (first !== undefined) {
      const family = await ensureSessionFamily(deps, session.sessionId);
      if (family.status === 'ready') {
        const adoption = adoptExistingMigrationChunk(deps.db, job.cohortId, first.sourceId);
        if (adoption.status === 'refused') {
          for (const problem of adoption.issues) {
            issue(deps, job, counts, problem.id, problem.reason);
          }
        } else if (adoption.status === 'not_sealed') {
          const coverage = checkPresentCoverage(deps.db, options.now);
          if (coverage.status !== 'checked') {
            return coverage.refusal.reason;
          }
          const measured = await measureChunkCandidates(
            deps,
            rows.map((row) => ({ ...row, createdAt: row.captureOrderValue })),
            coverage.context,
            job.policy,
          );
          if (measured.status === 'refused') {
            issue(deps, job, counts, session.sessionId, measured.reason);
          } else {
            const decision = decideChunkSeal({
              remainder: measured.candidates,
              now: options.now,
              policy: job.policy,
              sessionClosing: true,
            });
            if (decision.action === 'seal') {
              const sealed = sealMigrationMembership(deps.db, {
                cohortId: job.cohortId,
                sessionId: session.sessionId,
                at: options.now,
                members: chosenMigrationMembers(
                  rows,
                  decision.members.map((member) => member.sourceId),
                ),
              });
              counts.record('sealed', sealed.created ? 1 : 0);
            }
          }
        }
      } else {
        issue(deps, job, counts, session.sessionId, family.reason);
      }
    }
    advance('partition', { after: session });
    return undefined;
  }
  const partition = readCutoverPartition(deps.db, job.cohortId, session.sessionId);
  let ready = partition.reason === undefined;
  if (ready) {
    const result = await cutoverSessionFamily(deps, {
      sessionId: session.sessionId,
      cohortId: job.cohortId,
    });
    ready = result.status === 'acknowledged' || result.status === 'already_selected';
    counts.record('cutovers', result.status === 'acknowledged' ? 1 : 0);
    if (!ready && result.status !== 'acknowledged') {
      issue(deps, job, counts, session.sessionId, result.reason);
    }
  } else {
    issue(deps, job, counts, session.sessionId, partition.reason ?? 'partition_unverified');
  }
  advance('cutover', { after: session, allReady: (cursor.allReady ?? true) && ready });
  return undefined;
}

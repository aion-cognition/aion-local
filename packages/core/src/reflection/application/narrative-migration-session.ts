import { z } from 'zod';

import { measureChunkCandidates, type ChunkNarrativeDeps } from './chunk-seal.js';
import { cutoverSessionFamily, ensureSessionFamily } from './narrative-family.js';
import { ChunkSealRefused } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  listMigrationRemainder,
  sealMigrationMembership,
} from '../../infrastructure/sqlite/migration-partition.js';
import { MigrationRefused } from '../../infrastructure/sqlite/migration-refusal.js';
import { readCutoverPartition } from '../../infrastructure/sqlite/migration-session.js';
import {
  advanceNarrativeMigration,
  type NarrativeMigrationJob,
} from '../../infrastructure/sqlite/narrative-migration-job.js';
import { finishMigrationPass } from '../../infrastructure/sqlite/narrative-migration-pass.js';
import {
  adoptExistingMigrationChunk,
  chosenMigrationMembers,
  nextMigrationSession,
  unassignedOrderedMembers,
} from '../../infrastructure/sqlite/narrative-migration-read.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import { decideChunkSeal } from '../domain/chunk-boundary.js';

const Position = z.strictObject({ sessionId: z.string(), members: z.number().int().nonnegative() });
const Cursor = z.strictObject({
  after: Position.optional(),
  allReady: z.boolean().optional(),
  remainingAtStart: z.number().int().nonnegative().optional(),
});
export type MigrationSessionEffects = {
  readonly issue: (id: string, reason: string) => void;
  readonly sealed: (created: boolean) => void;
  readonly cutover: (changed: boolean) => void;
};

export async function migrateSessionStep(
  deps: ChunkNarrativeDeps,
  job: NarrativeMigrationJob,
  now: Date,
  effects: MigrationSessionEffects,
): Promise<string | undefined> {
  const cursor = Cursor.parse(job.cursor === '' ? {} : JSON.parse(job.cursor));
  const remainingAtStart =
    cursor.remainingAtStart ?? unassignedOrderedMembers(deps.db, job.cohortId);
  const session = nextMigrationSession(deps.db, job.cohortId, cursor.after);
  const advance = (
    phase: NarrativeMigrationJob['phase'],
    next: z.infer<typeof Cursor> = {},
  ): void => {
    advanceNarrativeMigration(deps.db, job, phase, JSON.stringify(next), now);
  };
  if (session === undefined) {
    if (job.phase === 'partition') {
      advanceNarrativeMigration(
        deps.db,
        job,
        unassignedOrderedMembers(deps.db, job.cohortId) > 0 &&
          unassignedOrderedMembers(deps.db, job.cohortId) < remainingAtStart
          ? 'partition'
          : 'publish',
        '',
        now,
      );
    } else {
      return finishMigrationPass(deps.db, job, cursor.allReady !== false, now);
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
            effects.issue(problem.id, problem.reason);
          }
        } else if (adoption.status === 'not_sealed') {
          const coverage = checkPresentCoverage(deps.db, now);
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
            effects.issue(session.sessionId, measured.reason);
          } else {
            const decision = decideChunkSeal({
              remainder: measured.candidates,
              now,
              policy: job.policy,
              sessionClosing: true,
            });
            if (decision.action === 'seal') {
              try {
                const sealed = sealMigrationMembership(deps.db, {
                  cohortId: job.cohortId,
                  sessionId: session.sessionId,
                  at: now,
                  members: chosenMigrationMembers(
                    rows,
                    decision.members.map((member) => member.sourceId),
                  ),
                });
                effects.sealed(sealed.created);
              } catch (error) {
                if (error instanceof MigrationRefused) {
                  effects.issue(error.id, error.reason);
                } else if (error instanceof ChunkSealRefused) {
                  effects.issue(error.sourceId, error.message);
                } else {
                  throw error;
                }
              }
            }
          }
        }
      } else {
        effects.issue(session.sessionId, family.reason);
      }
    }
    advance('partition', { after: session, remainingAtStart });
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
    effects.cutover(result.status === 'acknowledged');
    if (!ready && result.status !== 'acknowledged') {
      effects.issue(session.sessionId, result.reason);
    }
  } else {
    effects.issue(session.sessionId, partition.reason ?? 'partition_unverified');
  }
  advance('cutover', { after: session, allReady: (cursor.allReady ?? true) && ready });
  return undefined;
}

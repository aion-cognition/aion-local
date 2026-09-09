import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { enqueueLegacyIndexWork } from './intake-queue.js';
import { planMemberAttempt } from './legacy-attempts.js';
import { pageLegacyEpisodeCensus } from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  archiveRowidBounds,
  pageArchiveRows,
} from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  countMigrationProgress,
  freezeMigrationCohort,
  listAccountedCohortMembers,
  listRepairableCohortMembers,
  readIntakeWatermark,
  readMigrationCohort,
  readMigrationProgress,
  recordMigrationProgress,
  type MigrationStatus,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { hashContent } from '../domain/content.js';

/**
 * The resumable migration job: freeze a legacy cohort, walk it, and seal what it counted.
 *
 * Three separable steps, because they answer three different questions. The freeze fixes WHICH
 * sources the migration is about and writes that membership down before anything verifies a row,
 * so a restart can still name the graph-only members a digest could never re-list. The walk
 * proves each member against the graph and publishes its evidence through the coordinator. The
 * seal is the only step that says a scope has been counted, and it refuses while any member is
 * still unwalked.
 *
 * Nothing here invents ancestry. A member the archive and the graph disagree about is pinned with
 * the reason, stays resident, and is walked again the next time somebody has better evidence.
 */

export type LegacyBackfillDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly publications: {
    publish(request: {
      readonly kind: 'legacy_materialization';
      readonly operationId: string;
      readonly payload: unknown;
    }): Promise<PublicationOutcome>;
  };
};

export type CohortFreezeRequest = {
  readonly cohortId: string;
  readonly now: Date;
  /** The page size both enumerations walk in. The membership itself is not bounded by it. */
  readonly pageLimit?: number;
  readonly orderingPolicyVersion?: number;
};

export type CohortFreezeReport = {
  readonly cohortId: string;
  readonly members: number;
  readonly written: number;
  readonly archiveBacked: number;
  readonly graphOnly: number;
  readonly intakeWatermark: number;
};

const DEFAULT_PAGE = 200;
const DEFAULT_RELATION_LIMIT = 500;

/** Every episode the archive names inside the frozen bounds, walked in bounded pages. */
function archiveMembers(
  db: SqliteHandle,
  bounds: { readonly low: number; readonly high: number },
  pageLimit: number,
): readonly string[] {
  const members = new Set<string>();
  let cursor = 0;
  for (;;) {
    const page = pageArchiveRows(db, { ...bounds, cursor, limit: pageLimit });
    if (page.length === 0) {
      return [...members];
    }
    for (const row of page) {
      members.add(row.episodeId);
    }
    const last = page[page.length - 1];
    if (last === undefined || last.rowid <= cursor) {
      return [...members];
    }
    cursor = last.rowid;
  }
}

/** Every episode the graph holds, walked the same way. */
async function graphMembers(driver: Driver, pageLimit: number): Promise<readonly string[]> {
  const members: string[] = [];
  let after = '';
  for (;;) {
    const page = await pageLegacyEpisodeCensus(driver, after, pageLimit);
    if (page.length === 0) {
      return members;
    }
    members.push(...page);
    const last = page[page.length - 1];
    if (last === undefined || last <= after) {
      return members;
    }
    after = last;
  }
}

/**
 * Freezes the cohort and its whole membership in one call.
 *
 * The membership is the union of what the archive names inside the bounds and what the graph
 * holds, because a source that exists in only one of them is exactly the case the migration is
 * for. The watermark is captured beside them, so the tail cohort starts where this one ends and
 * no arrival falls between the two.
 */
export async function freezeLegacyCohort(
  deps: LegacyBackfillDeps,
  request: CohortFreezeRequest,
): Promise<CohortFreezeReport> {
  // A frozen cohort is frozen. Re-enumerating under its id would count a population its bounds
  // and its digest do not describe, and a restart after any intake would then be refused for
  // disagreeing with the record it is trying to resume.
  const frozen = readMigrationCohort(deps.db, request.cohortId);
  if (frozen !== undefined) {
    const counts = countMigrationProgress(deps.db, request.cohortId);
    const members = counts.accounted + counts.verified + counts.pinned;
    return {
      cohortId: frozen.cohortId,
      members,
      written: 0,
      archiveBacked: archiveBackedMembers(deps.db, request.cohortId),
      graphOnly: members - archiveBackedMembers(deps.db, request.cohortId),
      intakeWatermark: frozen.intakeWatermark,
    };
  }
  const pageLimit = request.pageLimit ?? DEFAULT_PAGE;
  const bounds = archiveRowidBounds(deps.db);
  const intakeWatermark = readIntakeWatermark(deps.db);
  const fromArchive = archiveMembers(deps.db, bounds, pageLimit);
  const fromGraph = await graphMembers(deps.driver, pageLimit);
  const members = [...new Set([...fromArchive, ...fromGraph])].sort();
  const graphCensusDigest = hashContent([...fromGraph].sort());
  const written = freezeMigrationCohort(deps.db, {
    cohortId: request.cohortId,
    cohortDigest: hashContent({ bounds, intakeWatermark, members }),
    intakeWatermark,
    archiveRowidLow: bounds.low,
    archiveRowidHigh: bounds.high,
    graphCensusDigest,
    orderingPolicyVersion: request.orderingPolicyVersion ?? 1,
    createdAt: request.now,
    members,
  });
  const archiveBacked = new Set(fromArchive);
  return {
    cohortId: request.cohortId,
    members: members.length,
    written,
    archiveBacked: archiveBacked.size,
    graphOnly: members.filter((member) => !archiveBacked.has(member)).length,
    intakeWatermark,
  };
}

/** Frozen members the archive names inside the cohort's own bounds. */
function archiveBackedMembers(db: SqliteHandle, cohortId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM migration_progress m
       JOIN migration_cohorts c ON c.cohort_id = m.cohort_id
       WHERE m.cohort_id = ?
         AND EXISTS (
           SELECT 1 FROM experience_archive a
           WHERE a.episode_id = m.source_id
             AND a.rowid >= c.archive_rowid_low AND a.rowid <= c.archive_rowid_high
         )`,
    )
    .get(cohortId) as { n: number };
  return row.n;
}

export type BackfillBatchRequest = {
  readonly cohortId: string;
  readonly now: Date;
  readonly limit?: number;
  readonly relationLimit?: number;
  readonly indexPolicy?: string;
  /**
   * Re-prove members that already read verified. The ordinary walk does not: it leaves a live
   * acceptance's record alone. A rebuild pass does, because what it needs to know is whether the
   * proof still holds.
   */
  readonly reverify?: boolean;
};

export type MemberOutcome = {
  readonly sourceId: string;
  readonly status: MigrationStatus;
  readonly reason: string;
  readonly published: PublicationOutcome['status'] | 'skipped';
};

export type BackfillBatchReport = {
  readonly walked: number;
  readonly verified: number;
  readonly pinned: number;
  readonly indexEnqueued: number;
  readonly outcomes: readonly MemberOutcome[];
  readonly remaining: number;
};

/**
 * One bounded batch of the walk.
 *
 * The frozen membership is the cursor. A member is verified or pinned, its index work is
 * enqueued, and its evidence is published through the coordinator before the progress row moves,
 * so a crash between the two leaves the member accounted and walks it again rather than marking
 * it done on a publication that never landed.
 */
export async function runLegacyBackfillBatch(
  deps: LegacyBackfillDeps,
  request: BackfillBatchRequest,
): Promise<BackfillBatchReport> {
  const cohort = readMigrationCohort(deps.db, request.cohortId);
  if (cohort === undefined) {
    throw new Error(`cohort ${request.cohortId} was never frozen`);
  }
  const bounds = { low: cohort.archiveRowidLow, high: cohort.archiveRowidHigh };
  // A repair pass selects the pinned members too. A pin is a walk that could not prove something,
  // and an explicit re-verification is the request to try it again on better evidence — if the
  // selection stayed on the unreached members, the only way back into the population would be
  // editing the progress table by hand.
  const members = (
    request.reverify === true ? listRepairableCohortMembers : listAccountedCohortMembers
  )(deps.db, request.cohortId, '', request.limit ?? DEFAULT_PAGE);
  const outcomes: MemberOutcome[] = [];
  let indexEnqueued = 0;
  for (const sourceId of members) {
    const attempt = planMemberAttempt(deps.db, {
      cohortId: request.cohortId,
      sourceId,
      status: readMigrationProgress(deps.db, request.cohortId, sourceId)?.status,
      reverify: request.reverify === true,
      payload: {
        mode: 'source',
        cohortId: request.cohortId,
        sourceId,
        relationLimit: request.relationLimit ?? DEFAULT_RELATION_LIMIT,
        archiveRowidLow: bounds.low,
        archiveRowidHigh: bounds.high,
        reverify: request.reverify === true,
      },
    });
    // Out of identities. The member takes a durable pin with the reason rather than aborting the
    // batch: it stays resident, it stays out of every seal, and the next person can see why.
    if (attempt.exhausted !== undefined || attempt.operationId === undefined) {
      const reason = attempt.exhausted ?? 'no walk identity was available';
      recordMigrationProgress(deps.db, {
        cohortId: request.cohortId,
        sourceId,
        status: 'pinned',
        reason,
      });
      outcomes.push({ sourceId, status: 'pinned', reason, published: 'skipped' });
      continue;
    }
    // One publication proves the source and materializes what it proved. The verdict is taken
    // under the guard, so nothing outside it decides what a source's records say.
    const outcome =
      attempt.receipt === undefined
        ? await deps.publications.publish({
            kind: 'legacy_materialization',
            operationId: attempt.operationId,
            payload: attempt.payload,
          })
        : ({ status: 'acknowledged', reason: attempt.receipt.reason, result: attempt.receipt } as {
            status: PublicationOutcome['status'];
            reason: string;
            result: unknown;
          });
    const published = outcome.status;
    // A member whose publication did not land stays accounted. Marking it walked on a
    // publication the coordinator deferred would take it out of the population the census seal
    // waits on, and the seal would then count a scope whose rows were never written.
    if (outcome.status !== 'acknowledged') {
      outcomes.push({ sourceId, status: 'accounted', reason: outcome.reason, published });
      continue;
    }
    const result = outcome.result as { pinned?: boolean; verified?: boolean; reason?: string };
    // The producer's two gates are different failures. An unverified source has no proof at all;
    // a verified one can still hold an incident relationship nobody can classify, and then its
    // evidence is not materialized. Either way the cohort records a pin, which is what keeps the
    // source out of every eligible-for-removal population.
    const status: MigrationStatus =
      result.verified === true && result.pinned !== true ? 'verified' : 'pinned';
    const reason = result.reason ?? 'the producer recorded no reason';
    // Index work follows the RAW proof, not the relationship one. A source whose parts are
    // provable can be searched whatever its edges turned out to be, and a pinned source is held
    // against removal anyway; withholding its index would only make it unfindable as well.
    if (result.verified === true) {
      const record = readSourceRecord(deps.db, sourceId);
      if (
        enqueueLegacyIndexWork(
          deps.db,
          {
            sourceId,
            sessionId: record?.sessionId ?? sourceId,
            lane: 'bulk',
            indexPolicy: request.indexPolicy ?? 'legacy_v1',
            acceptedAt: request.now.toISOString(),
          },
          request.cohortId,
        )
      ) {
        indexEnqueued += 1;
      }
    }
    recordMigrationProgress(deps.db, { cohortId: request.cohortId, sourceId, status, reason });
    outcomes.push({ sourceId, status, reason, published });
  }

  const counts = countMigrationProgress(deps.db, request.cohortId);
  return {
    walked: members.length,
    verified: outcomes.filter((entry) => entry.status === 'verified').length,
    pinned: outcomes.filter((entry) => entry.status === 'pinned').length,
    indexEnqueued,
    outcomes,
    remaining: counts.accounted,
  };
}

export type CensusSealReport = {
  readonly pages: number;
  readonly endpoints: number;
  readonly deferred?: string;
};

/**
 * The seal: the only step that establishes a census, and only once the walk owes nothing.
 *
 * It pages until the scope table has no uncounted endpoint left. A deferral is not a failure — it
 * is the coordinator saying the cohort still has members nobody has walked, which is exactly the
 * condition a census may not be published under.
 */
export async function sealLegacyCohortCensus(
  deps: LegacyBackfillDeps,
  request: {
    readonly cohortId: string;
    readonly endpointLimit?: number;
    readonly relationLimit?: number;
  },
): Promise<CensusSealReport> {
  const endpointLimit = request.endpointLimit ?? DEFAULT_PAGE;
  const relationLimit = request.relationLimit ?? DEFAULT_RELATION_LIMIT;
  let pages = 0;
  let endpoints = 0;
  let after = '';
  for (;;) {
    const outcome = await deps.publications.publish({
      kind: 'legacy_materialization',
      operationId: `legacy-census:${request.cohortId}:${randomUUID()}`,
      payload: {
        mode: 'census',
        cohortId: request.cohortId,
        endpointLimit,
        after,
        relationLimit,
      },
    });
    if (outcome.status !== 'acknowledged') {
      return { pages, endpoints, deferred: outcome.reason };
    }
    const result = outcome.result as { established?: number; cursor?: string };
    const established = result.established ?? 0;
    pages += 1;
    endpoints += established;
    // The cursor is what makes the loop terminate, and it moves over every endpoint the page
    // LOOKED AT. An endpoint whose population this cohort cannot prove seals nothing and stays
    // uncounted for whoever covers it later; stopping on it would leave every endpoint behind it
    // unsealed, and paging from zero would hand it back forever.
    if (result.cursor === undefined || result.cursor <= after) {
      return { pages, endpoints };
    }
    after = result.cursor;
  }
}

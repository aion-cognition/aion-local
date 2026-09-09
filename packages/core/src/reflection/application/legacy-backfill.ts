import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { enqueueLegacyIndexWork } from './intake-queue.js';
import { sourcePartsOf } from './source-manifest.js';
import {
  findLegacyRawNodes,
  pageLegacyEpisodeCensus,
  type LegacyRawNodes,
} from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  getExperienceById,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  archiveRowidBounds,
  groupArchiveRowsBySource,
  pageArchiveRows,
  pageArchiveRowsForEpisode,
  verifiedSourceRecordInput,
  type ArchiveSourceGroup,
} from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  countMigrationProgress,
  freezeMigrationCohort,
  listAccountedCohortMembers,
  readIntakeWatermark,
  readMigrationCohort,
  recordMigrationProgress,
  type MigrationStatus,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  recordSourceParts,
  recordSourceRecord,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { hashContent, prepareEpisode } from '../domain/content.js';

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

export type BackfillBatchRequest = {
  readonly cohortId: string;
  readonly now: Date;
  readonly limit?: number;
  readonly relationLimit?: number;
  readonly indexPolicy?: string;
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

type Verdict = {
  readonly status: MigrationStatus;
  readonly reason: string;
};

/**
 * What the archive and the graph together say about one member.
 *
 * A source the live intake already verified is left alone: its record was written by the writer
 * that accepted it, under proof this walk cannot improve on, and rewriting it from the archive
 * would replace an acceptance clock with a migration's own. Every other case is decided against
 * both stores, and a disagreement pins rather than picking a side.
 */
function verifyMember(
  db: SqliteHandle,
  sourceId: string,
  group: ArchiveSourceGroup | undefined,
  raw: LegacyRawNodes | undefined,
  now: Date,
): Verdict {
  const held = readSourceRecord(db, sourceId);
  if (held?.verificationStatus === 'verified') {
    return { status: 'verified', reason: 'the live acceptance already proved this source' };
  }
  const pin = (reason: string): Verdict => {
    recordSourceRecord(db, {
      sourceId,
      sessionId: group?.sessionId ?? raw?.sessionId ?? held?.sessionId ?? sourceId,
      verificationStatus: 'pinned',
      verificationReason: reason,
      occurredAt: group?.occurredAt ?? held?.occurredAt ?? now.toISOString(),
      createdAt: now,
      ...(group === undefined
        ? { captureOrderBasis: 'pinned' as const }
        : {
            captureOrderValue: group.archivedAt,
            captureOrderBasis: 'archive_acceptance' as const,
          }),
    });
    return { status: 'pinned', reason };
  };
  if (group === undefined) {
    return pin('the archive holds no row for this source inside the frozen bounds');
  }
  if (group.conflictingAliases) {
    return pin('archive rows for this episode disagree about its content');
  }
  if (raw === undefined) {
    return pin('the graph holds no projection of this source');
  }
  if (raw.contentHash === undefined || raw.contentHash !== group.contentHash) {
    return pin('the archived digest disagrees with the graph projection');
  }
  const experience = getExperienceById(db, group.canonicalArchiveId);
  if (experience === undefined) {
    return pin('the canonical archive row could not be read back');
  }
  // The parts come from the payload, because that is where they all are. Only turns have a graph
  // node; an observation and a tool execution have a logical address and nothing else, and a walk
  // that recorded only what the graph shows would leave those parts uncitable forever.
  const prepared = prepareEpisode(experience.payload, new Date(group.occurredAt));
  const mismatch = prepared.turns.findIndex(
    (turn, index) => raw.turns[index]?.contentHash !== turn.contentHash,
  );
  if (mismatch >= 0) {
    return pin(`graph turn ${String(mismatch)} does not carry the archived turn's digest`);
  }
  recordSourceRecord(
    db,
    verifiedSourceRecordInput(group, {
      verificationPolicyVersion: ARCHIVE_SCHEMA_VERSION,
      createdAt: now,
    }),
  );
  recordSourceParts(
    db,
    sourceId,
    sourcePartsOf(
      prepared,
      experience.payload,
      raw.turns.map((turn) => turn.turnId),
    ),
  );
  return { status: 'verified', reason: 'the archived digest matches the graph projection' };
}

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
  const members = listAccountedCohortMembers(
    deps.db,
    request.cohortId,
    '',
    request.limit ?? DEFAULT_PAGE,
  );
  const outcomes: MemberOutcome[] = [];
  let indexEnqueued = 0;
  for (const sourceId of members) {
    const group = groupArchiveRowsBySource(
      pageArchiveRowsForEpisode(deps.db, sourceId, bounds),
    ).find((entry) => entry.sourceId === sourceId);
    const raw = await findLegacyRawNodes(deps.driver, sourceId);
    const verdict = verifyMember(deps.db, sourceId, group, raw, request.now);
    let settled = verdict;
    let published: MemberOutcome['published'] = 'skipped';
    if (verdict.status === 'verified') {
      const record = readSourceRecord(deps.db, sourceId);
      if (
        enqueueLegacyIndexWork(
          deps.db,
          {
            sourceId,
            sessionId: record?.sessionId ?? raw?.sessionId ?? sourceId,
            lane: 'bulk',
            indexPolicy: request.indexPolicy ?? 'legacy_v1',
            acceptedAt: request.now.toISOString(),
          },
          request.cohortId,
        )
      ) {
        indexEnqueued += 1;
      }
      const outcome = await deps.publications.publish({
        kind: 'legacy_materialization',
        operationId: `legacy-materialization:${request.cohortId}:${sourceId}`,
        payload: {
          mode: 'source',
          cohortId: request.cohortId,
          sourceId,
          relationLimit: request.relationLimit ?? DEFAULT_RELATION_LIMIT,
        },
      });
      published = outcome.status;
      // The producer's own gate. A source whose archive proof holds can still have an incident
      // relationship nobody can classify, and that is a different failure from an unverified
      // row: the source stays, its evidence is not materialized, and the cohort records the
      // reason. Pinning it here is what keeps it out of every eligible-for-removal population.
      if (outcome.status === 'acknowledged') {
        const result = outcome.result as { pinned?: boolean; reason?: string };
        if (result.pinned === true) {
          settled = {
            status: 'pinned',
            reason: result.reason ?? 'the producer could not prove it',
          };
        }
      }
    }
    // A member whose evidence did not land stays accounted. Marking it walked on a publication
    // the coordinator deferred would take it out of the population the census seal waits on, and
    // the seal would then count a scope whose rows were never written.
    if (published !== 'deferred' && published !== 'rejected') {
      recordMigrationProgress(deps.db, {
        cohortId: request.cohortId,
        sourceId,
        status: settled.status,
        reason: settled.reason,
      });
    }
    outcomes.push({ sourceId, status: settled.status, reason: settled.reason, published });
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
  request: { readonly cohortId: string; readonly endpointLimit?: number },
): Promise<CensusSealReport> {
  const endpointLimit = request.endpointLimit ?? DEFAULT_PAGE;
  let pages = 0;
  let endpoints = 0;
  let after = '';
  for (;;) {
    const outcome = await deps.publications.publish({
      kind: 'legacy_materialization',
      operationId: `legacy-census:${request.cohortId}:${randomUUID()}`,
      payload: { mode: 'census', cohortId: request.cohortId, endpointLimit, after },
    });
    if (outcome.status !== 'acknowledged') {
      return { pages, endpoints, deferred: outcome.reason };
    }
    const result = outcome.result as { established?: number; cursor?: string };
    const established = result.established ?? 0;
    pages += 1;
    endpoints += established;
    // The cursor is what makes the loop terminate: an endpoint whose scopes nobody can seal
    // stays uncounted, and paging from zero every time would hand it back forever.
    if (established === 0 || result.cursor === undefined || result.cursor <= after) {
      return { pages, endpoints };
    }
    after = result.cursor;
  }
}

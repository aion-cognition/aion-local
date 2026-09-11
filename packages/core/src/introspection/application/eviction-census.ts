import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countRunnableSurvivorWork } from '../../infrastructure/sqlite/eviction-manifests.js';
import { experiencePayloadBytes } from '../../infrastructure/sqlite/experience-archive.js';
import { coordinatorControl } from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import {
  durableEligibility,
  type EvictionCandidate,
} from '../../reflection/application/eviction-eligibility.js';
import type { EvictionDemand } from '../domain/health.js';

/**
 * The eviction census: a bounded page of resident sources, each run through the same durable
 * fence a run publishes behind, and the work a committed eviction already owes.
 *
 * It asks SQLite and nothing else. An observation tick has no guard and no graph transaction, so
 * a demand number that needed either would be a number no tick could take; what it costs is that
 * the graph half of eligibility — the incident census and its classification — is invisible here,
 * and a source this scan calls eligible can still pin under the guard. The count is therefore an
 * upper bound on what a run will remove and is named as the durable half rather than as a
 * promise.
 *
 * The scan is keyset-paged and resumable for the reason every other nomination here is: a source
 * that pins for a reason nothing clears would otherwise hold the head of the enumeration forever
 * and the sources behind it would never be reached.
 */

/** C9 §4's selection page: rows examined per pass, apart from the attempts one pass spends. */
export const EVICTION_SCAN_PAGE = 200;

export type EvictionCursor = { readonly sourceId: string };

export type EvictionScanOptions = {
  readonly now: Date;
  readonly minAgeMs: number;
  readonly limit: number;
  readonly after?: EvictionCursor;
};

export type EvictionScan = {
  readonly candidates: readonly EvictionCandidate[];
  readonly pinsByReason: Readonly<Record<string, number>>;
  /** The last row examined, pinned or not. Absent when the enumeration ended. */
  readonly cursor: EvictionCursor | undefined;
  readonly examined: number;
};

/**
 * Sources whose raw projection is still here and whose chunk has a published head.
 *
 * Those two facts are in the query rather than in the fence because they are what makes a row
 * worth reading at all: an evicted source has nothing to remove and an unpublished chunk cannot
 * qualify anything. Every other condition is the fence's, one row at a time.
 */
const CANDIDATE_PAGE = `SELECT r.source_id AS sourceId
  FROM source_records r
  JOIN chunk_members m ON m.source_id = r.source_id
  JOIN chunks c ON c.chunk_id = m.chunk_id AND c.published_revision_no IS NOT NULL
  LEFT JOIN source_residency sr ON sr.source_id = r.source_id
  WHERE r.verification_status = 'verified'
    AND coalesce(sr.state, 'resident') = 'resident'`;

export function scanEvictionCandidates(
  db: SqliteHandle,
  options: EvictionScanOptions,
): EvictionScan {
  const keyset = options.after === undefined ? '' : 'AND r.source_id > ?';
  const parameters =
    options.after === undefined ? [options.limit] : [options.after.sourceId, options.limit];
  const rows = db
    .prepare(`${CANDIDATE_PAGE} ${keyset} ORDER BY r.source_id LIMIT ?`)
    .all(...parameters) as { sourceId: string }[];
  const candidates: EvictionCandidate[] = [];
  const pins: Record<string, number> = {};
  let cursor: EvictionCursor | undefined;
  for (const row of rows) {
    cursor = { sourceId: row.sourceId };
    const verdict = durableEligibility(db, row.sourceId, {
      now: options.now,
      minAgeMs: options.minAgeMs,
    });
    if (verdict.status === 'eligible') {
      candidates.push(verdict.candidate);
    } else {
      pins[verdict.reason] = (pins[verdict.reason] ?? 0) + 1;
    }
  }
  return {
    candidates,
    pinsByReason: pins,
    cursor: rows.length < options.limit ? undefined : cursor,
    examined: rows.length,
  };
}

/** Archived payload bytes behind a candidate, or nothing when the archive cannot answer. */
function estimatedBytes(db: SqliteHandle, candidate: EvictionCandidate): number {
  const archiveId = readSourceRecord(db, candidate.sourceId)?.canonicalArchiveId;
  return archiveId === null || archiveId === undefined
    ? 0
    : (experiencePayloadBytes(db, archiveId) ?? 0);
}

export type EvictionCensusOptions = {
  readonly now: Date;
  readonly minAgeMs: number;
  readonly scanLimit?: number;
};

/**
 * The reading the tick records.
 *
 * The two halves are collected in their own try blocks on purpose: losing the fresh census to a
 * manifest error must not hide an acknowledged eviction's owed survivor work behind a collector
 * name, and losing the control record must not turn a countable population into no reading.
 */
export function readEvictionDemand(
  db: SqliteHandle,
  options: EvictionCensusOptions,
): EvictionDemand {
  let pendingRecovery: boolean | undefined;
  let pendingSurvivorWork: number | undefined;
  const diagnostics: string[] = [];
  try {
    pendingRecovery = coordinatorControl(db).pendingOperationId !== null;
    pendingSurvivorWork = countRunnableSurvivorWork(db, options.now);
  } catch {
    diagnostics.push('pending_work_unreadable');
  }
  try {
    const scan = scanEvictionCandidates(db, {
      now: options.now,
      minAgeMs: options.minAgeMs,
      limit: options.scanLimit ?? EVICTION_SCAN_PAGE,
    });
    const ages = scan.candidates.map(
      (candidate) => options.now.getTime() - Date.parse(candidate.qualifiedAt),
    );
    return {
      eligibleSources: scan.candidates.length,
      eligibleTurns: scan.candidates.reduce((total, one) => total + one.turnIds.length, 0),
      estimatedBytes: scan.candidates.reduce((total, one) => total + estimatedBytes(db, one), 0),
      oldestQualifiedAgeMs: ages.length === 0 ? undefined : Math.max(...ages),
      pinsByReason: scan.pinsByReason,
      pendingSurvivorWork,
      pendingRecovery,
      availability: 'measured',
      ...(diagnostics.length === 0 ? {} : { diagnostic: diagnostics.join(',') }),
    };
  } catch (err) {
    diagnostics.push(err instanceof Error ? err.message : String(err));
    return {
      eligibleSources: undefined,
      eligibleTurns: undefined,
      estimatedBytes: undefined,
      oldestQualifiedAgeMs: undefined,
      pinsByReason: {},
      pendingSurvivorWork,
      pendingRecovery,
      availability: 'unavailable',
      diagnostic: diagnostics.join(','),
    };
  }
}

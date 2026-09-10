import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * Allocation and publication for both narrative families. Chunks and calendar overviews carry
 * the same revision columns, so one helper serves both and the family is a value the caller
 * passes rather than a table name it supplies. The two constants below are the whole set: no
 * caller names a table or a column of its own.
 *
 * A revision number is allocated durably before any provider work starts. An attempt that is
 * abandoned therefore leaves a gap in the numbering, which is the intended outcome: a number
 * that was ever handed out is spent, and the next allocation moves past it. The published head
 * moves only when a publication succeeds, so a gap is invisible to a reader.
 */
export type RevisionFamily = {
  readonly revisionTable: string;
  readonly keyColumn: string;
  readonly headTable: string;
  readonly headKeyColumn: string;
  /**
   * Whether the helper creates the row that holds the head. The overview registry is nothing
   * but allocation state and is created on first use; a chunk row is written when the chunk
   * seals and carries membership, so publishing into a chunk that was never sealed is an
   * error rather than a row to invent.
   */
  readonly createsHeadRow: boolean;
};

export const CHUNK_REVISION_FAMILY: RevisionFamily = {
  revisionTable: 'chunk_revisions',
  keyColumn: 'chunk_id',
  headTable: 'chunks',
  headKeyColumn: 'chunk_id',
  createsHeadRow: false,
};

export const OVERVIEW_REVISION_FAMILY: RevisionFamily = {
  revisionTable: 'overview_revisions',
  keyColumn: 'family_key',
  headTable: 'overview_registry',
  headKeyColumn: 'family_key',
  createsHeadRow: true,
};

/** States an allocated revision may still be published from. */
const PUBLISHABLE_STATES = new Set(['allocated', 'prepared']);

export type NarrativeRevisionAllocation = {
  readonly revisionNo: number;
  readonly nodeId: string;
};

export type NarrativeRevisionRow = {
  readonly familyKey: string;
  readonly revisionNo: number;
  readonly nodeId: string;
  readonly state: string;
  readonly operationId: string | null;
  readonly allocatedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly blockedReason: string | null;
  readonly lastFailureReason: string | null;
};

type RevisionRowData = {
  key: string;
  revision_no: number;
  node_id: string;
  state: string;
  operation_id: string | null;
  allocated_at: string;
  attempts: number;
  next_attempt_at: string | null;
  blocked_reason: string | null;
  last_failure_reason: string | null;
};

/** Equality-only by construction: the inputs are not recoverable from the id. */
export function narrativeRevisionNodeId(familyKey: string, revisionNo: number): string {
  return createHash('sha256').update(`${familyKey}\u0000${revisionNo}`).digest('hex');
}

function toRevisionRow(row: RevisionRowData): NarrativeRevisionRow {
  return {
    familyKey: row.key,
    revisionNo: row.revision_no,
    nodeId: row.node_id,
    state: row.state,
    operationId: row.operation_id,
    allocatedAt: row.allocated_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    blockedReason: row.blocked_reason,
    lastFailureReason: row.last_failure_reason,
  };
}

function selectRevisions(family: RevisionFamily, where: string): string {
  return `SELECT ${family.keyColumn} AS key, revision_no, node_id, state, operation_id, allocated_at,
            attempts, next_attempt_at, blocked_reason, last_failure_reason
          FROM ${family.revisionTable} ${where}`;
}

function highWater(db: SqliteHandle, family: RevisionFamily, familyKey: string): number {
  const allocated = db
    .prepare(
      `SELECT COALESCE(MAX(revision_no), 0) AS n FROM ${family.revisionTable}
       WHERE ${family.keyColumn} = ?`,
    )
    .get(familyKey) as { n: number };
  if (!family.createsHeadRow) {
    return allocated.n;
  }
  const registry = db
    .prepare(
      `SELECT COALESCE(MAX(allocated_high_water), 0) AS n FROM ${family.headTable}
       WHERE ${family.headKeyColumn} = ?`,
    )
    .get(familyKey) as { n: number };
  return Math.max(allocated.n, registry.n);
}

/**
 * Allocates the next revision number and writes its row before anything outside sees it. The
 * read of the high-water and the write of the row are one immediate transaction, so two
 * callers racing a fresh family get two numbers rather than one number twice.
 */
export function allocateNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  allocatedAt: Date,
): NarrativeRevisionAllocation {
  return db
    .transaction((): NarrativeRevisionAllocation => {
      const revisionNo = highWater(db, family, familyKey) + 1;
      const nodeId = narrativeRevisionNodeId(familyKey, revisionNo);
      db.prepare(
        `INSERT INTO ${family.revisionTable} (${family.keyColumn}, revision_no, node_id, state, allocated_at)
         VALUES (?, ?, ?, 'allocated', ?)`,
      ).run(familyKey, revisionNo, nodeId, allocatedAt.toISOString());
      if (family.createsHeadRow) {
        db.prepare(
          `INSERT INTO ${family.headTable} (${family.headKeyColumn}, allocated_high_water)
           VALUES (?, ?)
           ON CONFLICT (${family.headKeyColumn}) DO UPDATE SET allocated_high_water = excluded.allocated_high_water`,
        ).run(familyKey, revisionNo);
      }
      return { revisionNo, nodeId };
    })
    .immediate();
}

/**
 * Marks an allocation as abandoned. The row stays, so the number it holds stays spent and the
 * next allocation moves past it. Returns false when the revision had already left an
 * abandonable state, which is a caller repeating itself rather than a failure.
 */
export function abandonNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
  closedAt: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET state = 'abandoned', closed_at = ?
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state IN ('allocated','prepared')`,
    )
    .run(closedAt.toISOString(), familyKey, revisionNo);
  return result.changes === 1;
}

/**
 * Binds an allocated revision to the operation that is about to publish it.
 *
 * The row is what makes the attempt discoverable after a restart: the durable intent carries the
 * output, and this says which revision number that intent was prepared against. It moves only
 * from `allocated`, so a second operation cannot take a revision another one is already holding.
 */
export function prepareNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
  operationId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET state = 'prepared', operation_id = ?
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'`,
    )
    .run(operationId, familyKey, revisionNo);
  return result.changes === 1;
}

/** Returns a prepared revision to `allocated` so a fresh attempt can take it. */
export function releaseNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET state = 'allocated', operation_id = NULL
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'prepared'`,
    )
    .run(familyKey, revisionNo);
  return result.changes === 1;
}

export type NarrativePublication = {
  readonly familyKey: string;
  readonly revisionNo: number;
  readonly operationId: string;
  readonly evidenceRevisionJson: string;
  readonly knownFrom: string;
  readonly observedAckAt: string;
  readonly publishedAt: Date;
  readonly coverageGapsJson?: string;
};

export type NarrativePublicationOutcome = {
  /** The head this publication superseded, or undefined when it was the first. */
  readonly supersededRevisionNo?: number;
};

/**
 * Publishes an allocated revision and moves the head to it. The state check is what rejects a
 * stale attempt: a revision that was abandoned, or already published, cannot become the head
 * later. The revision it supersedes is closed in the same transaction, whatever number that
 * revision holds, so a gap between the two is irrelevant to the outcome.
 */
export function publishNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  publication: NarrativePublication,
): NarrativePublicationOutcome {
  return db
    .transaction((): NarrativePublicationOutcome => {
      const current = db
        .prepare(
          `SELECT state FROM ${family.revisionTable} WHERE ${family.keyColumn} = ? AND revision_no = ?`,
        )
        .get(publication.familyKey, publication.revisionNo) as { state: string } | undefined;
      if (current === undefined) {
        throw new Error(
          `${family.revisionTable} ${publication.familyKey}/${publication.revisionNo} was never allocated`,
        );
      }
      if (!PUBLISHABLE_STATES.has(current.state)) {
        throw new Error(
          `${family.revisionTable} ${publication.familyKey}/${publication.revisionNo} is ${current.state} and cannot publish`,
        );
      }

      const head = db
        .prepare(
          `SELECT published_revision_no AS head FROM ${family.headTable} WHERE ${family.headKeyColumn} = ?`,
        )
        .get(publication.familyKey) as { head: number | null } | undefined;
      if (head === undefined) {
        throw new Error(`${family.headTable} has no row for ${publication.familyKey}`);
      }

      const publishedAt = publication.publishedAt.toISOString();
      db.prepare(
        `UPDATE ${family.revisionTable}
         SET state = 'published', operation_id = ?, evidence_revision_json = ?, known_from = ?,
             observed_ack_at = ?, published_at = ?, coverage_gaps_json = ?, blocked_reason = NULL
         WHERE ${family.keyColumn} = ? AND revision_no = ?`,
      ).run(
        publication.operationId,
        publication.evidenceRevisionJson,
        publication.knownFrom,
        publication.observedAckAt,
        publishedAt,
        publication.coverageGapsJson ?? null,
        publication.familyKey,
        publication.revisionNo,
      );

      if (head.head !== null) {
        db.prepare(
          `UPDATE ${family.revisionTable} SET state = 'closed', closed_at = ?
           WHERE ${family.keyColumn} = ? AND revision_no = ?`,
        ).run(publishedAt, publication.familyKey, head.head);
      }

      db.prepare(
        `UPDATE ${family.headTable} SET published_revision_no = ? WHERE ${family.headKeyColumn} = ?`,
      ).run(publication.revisionNo, publication.familyKey);

      return head.head === null ? {} : { supersededRevisionNo: head.head };
    })
    .immediate();
}

/** The published head, or undefined when nothing has published for this family key yet. */
export function readPublishedHead(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
): number | undefined {
  const row = db
    .prepare(
      `SELECT published_revision_no AS head FROM ${family.headTable} WHERE ${family.headKeyColumn} = ?`,
    )
    .get(familyKey) as { head: number | null } | undefined;
  return row?.head ?? undefined;
}

export type PublishedNarrativeRevision = {
  readonly revisionNo: number;
  readonly nodeId: string;
  /** The dependency set the head was published on, which is what invalidation is judged against. */
  readonly evidenceRevisionJson: string | null;
  readonly coverageGapsJson: string | null;
  readonly knownFrom: string | null;
};

/** The head itself, with the evidence and coverage it published under. */
export function readPublishedRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
): PublishedNarrativeRevision | undefined {
  const row = db
    .prepare(
      `SELECT revision_no, node_id, evidence_revision_json, coverage_gaps_json, known_from
       FROM ${family.revisionTable}
       WHERE ${family.keyColumn} = ? AND state = 'published'`,
    )
    .get(familyKey) as
    | {
        revision_no: number;
        node_id: string;
        evidence_revision_json: string | null;
        coverage_gaps_json: string | null;
        known_from: string | null;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        revisionNo: row.revision_no,
        nodeId: row.node_id,
        evidenceRevisionJson: row.evidence_revision_json,
        coverageGapsJson: row.coverage_gaps_json,
        knownFrom: row.known_from,
      };
}

export function readNarrativeRevision(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
): NarrativeRevisionRow | undefined {
  const row = db
    .prepare(selectRevisions(family, `WHERE ${family.keyColumn} = ? AND revision_no = ?`))
    .get(familyKey, revisionNo) as RevisionRowData | undefined;
  return row === undefined ? undefined : toRevisionRow(row);
}

/**
 * Allocated revisions whose effective due time has arrived, oldest first. The effective due
 * time is the retry time when one has been set and the allocation time otherwise, so a
 * revision that has never failed is due immediately without carrying a retry stamp it never
 * earned. A blocked revision is not nominated at all: its block clears on a changed
 * prerequisite, not on the clock.
 */
export function nominateRetryableRevisions(
  db: SqliteHandle,
  family: RevisionFamily,
  now: Date,
  limit: number,
): readonly NarrativeRevisionRow[] {
  const rows = db
    .prepare(
      `${selectRevisions(
        family,
        `WHERE state = 'allocated' AND blocked_reason IS NULL
           AND COALESCE(next_attempt_at, allocated_at) <= ?`,
      )}
       ORDER BY COALESCE(next_attempt_at, allocated_at), ${family.keyColumn}, revision_no
       LIMIT ?`,
    )
    .all(now.toISOString(), limit) as RevisionRowData[];
  return rows.map(toRevisionRow);
}

export type RevisionAttemptFailure = {
  readonly familyKey: string;
  readonly revisionNo: number;
  readonly reason: string;
  /** When the attempt may run again. Omitted leaves it due now. */
  readonly nextAttemptAt?: Date;
};

/** Counts one failed attempt and pushes the revision's next try out. */
export function recordRevisionAttemptFailure(
  db: SqliteHandle,
  family: RevisionFamily,
  failure: RevisionAttemptFailure,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable}
       SET attempts = attempts + 1, last_failure_reason = ?, next_attempt_at = ?
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'`,
    )
    .run(
      failure.reason,
      failure.nextAttemptAt?.toISOString() ?? null,
      failure.familyKey,
      failure.revisionNo,
    );
  return result.changes === 1;
}

/**
 * Pushes an already-counted attempt's next try out without counting a second one.
 *
 * The failure and the backoff are two decisions and they belong to two owners. Whoever ran the
 * attempt records what went wrong and how many attempts the revision has now had; the scheduler
 * decides when the next one may run, because how long to wait is a property of the cadence rather
 * than of the failure. Returns false where the revision has left `allocated`, which is a
 * publication that landed between the two.
 */
export function deferRevisionAttempt(
  db: SqliteHandle,
  family: RevisionFamily,
  familyKey: string,
  revisionNo: number,
  nextAttemptAt: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE ${family.revisionTable} SET next_attempt_at = ?
       WHERE ${family.keyColumn} = ? AND revision_no = ? AND state = 'allocated'`,
    )
    .run(nextAttemptAt.toISOString(), familyKey, revisionNo);
  return result.changes === 1;
}

/**
 * Takes a revision out of nomination until a prerequisite changes. A block is not a delay:
 * clearing it takes a changed prerequisite or a recorded reassessment of the policy the
 * attempt ran under, never the passage of time.
 */

// The block lifecycle moved out at this file's ceiling; every caller reads it here still.
export {
  blockRevisionAttempt,
  clearRevisionBlock,
  readBlockContext,
  type RevisionBlockContext,
} from './narrative-blocks.js';

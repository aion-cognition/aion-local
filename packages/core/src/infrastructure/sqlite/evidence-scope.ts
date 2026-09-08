import { createHash } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * Writer-owned scope counters and the token readers cite.
 *
 * A writer advances a scope in the same transaction as the semantic write it belongs to,
 * including the write that creates the scope. A reader never writes here: the most it can do
 * is read the published token and find out later that its copy no longer matches.
 *
 * Three numbers rather than one, and the split is what makes a deferred publication safe. A
 * prepared advance takes the next allocated number and parks it; acknowledgment promotes it to
 * published; a rejection drops it and leaves the published number where it was. The allocated
 * high-water never goes back, so a number a rejected attempt consumed is not handed out again
 * and a stale reader cannot be told the same token means two different states.
 */
export type ScopeCensusStatus = 'established' | 'unbackfilled' | 'unknown';

export type ScopeVersionRow = {
  readonly endpointId: string;
  readonly relationClass: string;
  readonly publishedRevision: number;
  readonly allocatedRevision: number;
  readonly pendingRevision: number | null;
  readonly pendingOperationId: string | null;
  readonly censusStatus: ScopeCensusStatus;
  readonly coverageJson: string | null;
  readonly updatedAt: string;
};

type ScopeRowData = {
  endpoint_id: string;
  relation_class: string;
  published_revision: number;
  allocated_revision: number;
  pending_revision: number | null;
  pending_operation_id: string | null;
  census_status: ScopeCensusStatus;
  coverage_json: string | null;
  updated_at: string;
};

export type ScopeKey = {
  readonly endpointId: string;
  /**
   * The full scope name: authority prefix, role and direction in one string, drawn from the
   * closed registry. There is no separate authority or direction column, and a free-form
   * string is not a scope.
   */
  readonly relationClass: string;
};

export type ScopeAdvance = ScopeKey & {
  readonly operationId: string;
  readonly updatedAt: Date;
};

const SELECT_SCOPE = `SELECT endpoint_id, relation_class, published_revision, allocated_revision,
    pending_revision, pending_operation_id, census_status, coverage_json, updated_at
  FROM evidence_scope_versions WHERE endpoint_id = ? AND relation_class = ?`;

function toScopeRow(row: ScopeRowData): ScopeVersionRow {
  return {
    endpointId: row.endpoint_id,
    relationClass: row.relation_class,
    publishedRevision: row.published_revision,
    allocatedRevision: row.allocated_revision,
    pendingRevision: row.pending_revision,
    pendingOperationId: row.pending_operation_id,
    censusStatus: row.census_status,
    coverageJson: row.coverage_json,
    updatedAt: row.updated_at,
  };
}

/** Opaque and comparable only for equality: the revision is not recoverable from the token. */
export function scopeVersionToken(
  endpointId: string,
  relationClass: string,
  revision: number,
): string {
  return createHash('sha256').update(`${endpointId} ${relationClass} ${revision}`).digest('hex');
}

export function readScopeVersion(db: SqliteHandle, key: ScopeKey): ScopeVersionRow | undefined {
  const row = db.prepare(SELECT_SCOPE).get(key.endpointId, key.relationClass) as
    ScopeRowData | undefined;
  return row === undefined ? undefined : toScopeRow(row);
}

/**
 * The token a dependency cites, or undefined when nothing has ever written this scope. An
 * absent scope has no token on purpose: minting one would turn "nobody has looked" into a
 * claim that the scope is empty.
 */
export function publishedScopeToken(db: SqliteHandle, key: ScopeKey): string | undefined {
  const row = readScopeVersion(db, key);
  if (row === undefined) {
    return undefined;
  }
  return scopeVersionToken(key.endpointId, key.relationClass, row.publishedRevision);
}

/**
 * Whether an empty result for this scope may satisfy a dependency. It may only when a census
 * has been established through an acknowledged baseline, never because a reader looked once
 * and found nothing.
 */
export function scopeSupportsVerifiedEmpty(db: SqliteHandle, key: ScopeKey): boolean {
  return readScopeVersion(db, key)?.censusStatus === 'established';
}

/**
 * Takes the next allocated number for a scope and parks it against the operation that will
 * publish it. Creating the scope is the same call, so the first relation written into a scope
 * nobody had touched advances it exactly like the thousandth.
 *
 * Throws when another operation already holds the pending slot: two prepared advances on one
 * scope would leave the promotion ambiguous.
 */
export function prepareScopeAdvance(db: SqliteHandle, advance: ScopeAdvance): number {
  return db
    .transaction((): number => {
      const current = readScopeVersion(db, advance);
      const updatedAt = advance.updatedAt.toISOString();
      if (current === undefined) {
        db.prepare(
          `INSERT INTO evidence_scope_versions
             (endpoint_id, relation_class, published_revision, allocated_revision, pending_revision,
              pending_operation_id, census_status, updated_at)
           VALUES (?, ?, 0, 1, 1, ?, 'unknown', ?)`,
        ).run(advance.endpointId, advance.relationClass, advance.operationId, updatedAt);
        return 1;
      }
      if (
        current.pendingOperationId !== null &&
        current.pendingOperationId !== advance.operationId
      ) {
        throw new Error(
          `scope ${advance.endpointId}/${advance.relationClass} already has a pending advance owned by ${current.pendingOperationId}`,
        );
      }
      if (current.pendingOperationId === advance.operationId && current.pendingRevision !== null) {
        return current.pendingRevision;
      }

      const allocated = current.allocatedRevision + 1;
      db.prepare(
        `UPDATE evidence_scope_versions
         SET allocated_revision = ?, pending_revision = ?, pending_operation_id = ?, updated_at = ?
         WHERE endpoint_id = ? AND relation_class = ?`,
      ).run(
        allocated,
        allocated,
        advance.operationId,
        updatedAt,
        advance.endpointId,
        advance.relationClass,
      );
      return allocated;
    })
    .immediate();
}

export type ScopeAcknowledgment = ScopeAdvance & {
  /**
   * Set only by a baseline operation that accounted for every page and category. Left out, the
   * census status stays whatever it was.
   */
  readonly censusStatus?: ScopeCensusStatus;
  readonly coverageJson?: string;
};

/**
 * Promotes a prepared advance to published. Returns the published revision, which is what the
 * new token is derived from. An acknowledgment naming an operation that does not hold the
 * pending slot changes nothing and returns undefined, so a late duplicate cannot promote a
 * number that belongs to a different attempt.
 */
export function acknowledgeScopeAdvance(
  db: SqliteHandle,
  acknowledgment: ScopeAcknowledgment,
): number | undefined {
  return db
    .transaction((): number | undefined => {
      const current = readScopeVersion(db, acknowledgment);
      const pending = current?.pendingRevision;
      if (
        current === undefined ||
        pending === null ||
        pending === undefined ||
        current.pendingOperationId !== acknowledgment.operationId
      ) {
        return undefined;
      }
      db.prepare(
        `UPDATE evidence_scope_versions
         SET published_revision = ?, pending_revision = NULL, pending_operation_id = NULL,
             census_status = ?, coverage_json = COALESCE(?, coverage_json), updated_at = ?
         WHERE endpoint_id = ? AND relation_class = ?`,
      ).run(
        pending,
        acknowledgment.censusStatus ?? current.censusStatus,
        acknowledgment.coverageJson ?? null,
        acknowledgment.updatedAt.toISOString(),
        acknowledgment.endpointId,
        acknowledgment.relationClass,
      );
      return pending;
    })
    .immediate();
}

/**
 * Drops a prepared advance. The published number and its token are untouched, so a reader
 * holding the old token is still current: nothing was published, so nothing changed. The
 * allocated high-water keeps the discarded number, so the next attempt gets a fresh one.
 */
export function rejectScopeAdvance(db: SqliteHandle, advance: ScopeAdvance): boolean {
  const result = db
    .prepare(
      `UPDATE evidence_scope_versions
       SET pending_revision = NULL, pending_operation_id = NULL, updated_at = ?
       WHERE endpoint_id = ? AND relation_class = ? AND pending_operation_id = ?`,
    )
    .run(
      advance.updatedAt.toISOString(),
      advance.endpointId,
      advance.relationClass,
      advance.operationId,
    );
  return result.changes === 1;
}

export type ScopeMirror = ScopeKey & {
  readonly mirroredRevision: number;
  readonly operationId: string;
  readonly mirroredAt: Date;
};

/**
 * Records what a graph-owned scope counter read at some moment. The graph advances its own
 * counter in its own transaction, so a mismatch here proves this copy is stale and a match
 * proves nothing: the publication checkpoint is what certifies a read.
 */
export type ScopeMirrorRow = {
  readonly mirroredRevision: number;
  readonly operationId: string;
  readonly mirroredAt: string;
};

/** The last recorded reading of a graph-owned counter, or nothing when none was ever taken. */
export function readScopeMirror(db: SqliteHandle, key: ScopeKey): ScopeMirrorRow | undefined {
  const row = db
    .prepare(
      `SELECT mirrored_revision, operation_id, mirrored_at FROM evidence_scope_mirrors
       WHERE endpoint_id = ? AND relation_class = ?`,
    )
    .get(key.endpointId, key.relationClass) as
    { mirrored_revision: number; operation_id: string; mirrored_at: string } | undefined;
  return row === undefined
    ? undefined
    : {
        mirroredRevision: row.mirrored_revision,
        operationId: row.operation_id,
        mirroredAt: row.mirrored_at,
      };
}

export function recordScopeMirror(db: SqliteHandle, mirror: ScopeMirror): void {
  db.prepare(
    `INSERT INTO evidence_scope_mirrors
       (endpoint_id, relation_class, mirrored_revision, operation_id, mirrored_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint_id, relation_class) DO UPDATE
       SET mirrored_revision = excluded.mirrored_revision,
           operation_id = excluded.operation_id,
           mirrored_at = excluded.mirrored_at`,
  ).run(
    mirror.endpointId,
    mirror.relationClass,
    mirror.mirroredRevision,
    mirror.operationId,
    mirror.mirroredAt.toISOString(),
  );
}

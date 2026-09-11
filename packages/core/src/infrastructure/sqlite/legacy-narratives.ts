import type { SqliteHandle } from './database.js';

export type LegacyNarrativeRecord = {
  readonly narrativeId: string;
  readonly sessionId: string;
  readonly verificationStatus: string;
  readonly verificationJson: string | null;
  readonly retiredAt: string | null;
  readonly retirementFamilyJson: string | null;
  readonly publication?: { readonly operationId: string; readonly knownFrom: string };
};

type LegacyRow = {
  narrative_id: string;
  session_id: string;
  verification_status: string;
  verification_json: string | null;
  retired_at: string | null;
  retirement_family_json: string | null;
  published_operation_id: string | null;
  published_known_from: string | null;
};

function readRow(row: LegacyRow): LegacyNarrativeRecord {
  if ((row.published_operation_id == null) !== (row.published_known_from == null)) {
    throw new Error('legacy publication binding is incomplete');
  }
  return {
    narrativeId: row.narrative_id,
    sessionId: row.session_id,
    verificationStatus: row.verification_status,
    verificationJson: row.verification_json,
    retiredAt: row.retired_at,
    retirementFamilyJson: row.retirement_family_json,
    ...(row.published_operation_id == null || row.published_known_from == null
      ? {}
      : {
          publication: {
            operationId: row.published_operation_id,
            knownFrom: row.published_known_from,
          },
        }),
  };
}

/** Only a new controlled publication owns this birth time; an inventory never replaces it. */
export function acknowledgeLegacyNarrativeBirth(
  db: SqliteHandle,
  narrativeId: string,
  operationId: string,
  knownFrom: string,
): void {
  if (!db.inTransaction) {
    throw new Error('legacy narrative birth requires its acknowledgment transaction');
  }
  const held = readLegacyNarrative(db, narrativeId);
  if (
    held === undefined ||
    (held.publication !== undefined &&
      (held.publication.operationId !== operationId || held.publication.knownFrom !== knownFrom))
  ) {
    throw new Error('legacy narrative publication identity changed');
  }
  db.prepare(
    'UPDATE legacy_narratives SET published_operation_id = ?, published_known_from = ? WHERE narrative_id = ?',
  ).run(operationId, knownFrom, narrativeId);
}

/** The preserved legacy identity and its independent representation retirement. */
export function readLegacyNarrative(
  db: SqliteHandle,
  narrativeId: string,
): LegacyNarrativeRecord | undefined {
  const row = db
    .prepare('SELECT * FROM legacy_narratives WHERE narrative_id = ?')
    .get(narrativeId) as LegacyRow | undefined;
  return row === undefined ? undefined : readRow(row);
}

/** One bounded page of the historical versions, including retired representations. */
export function listLegacyNarratives(
  db: SqliteHandle,
  sessionId: string,
  limit: number,
  after = '',
): readonly LegacyNarrativeRecord[] {
  return (
    db
      .prepare(
        'SELECT * FROM legacy_narratives WHERE session_id = ? AND narrative_id > ? ORDER BY narrative_id LIMIT ?',
      )
      .all(sessionId, after, limit) as LegacyRow[]
  ).map(readRow);
}

/** Identity cannot migrate between sessions when a newer inventory is recorded. */
export function recordLegacyNarrative(
  db: SqliteHandle,
  input: {
    readonly narrativeId: string;
    readonly sessionId: string;
    readonly verificationStatus: 'verified' | 'pinned';
    readonly verificationJson: string;
    readonly createdAt: Date;
  },
): void {
  if (!db.inTransaction) {
    throw new Error('legacy narrative recording requires its publication transaction');
  }
  const held = readLegacyNarrative(db, input.narrativeId);
  if (held !== undefined && held.sessionId !== input.sessionId) {
    throw new Error('legacy narrative identity is already bound to another session');
  }
  db.prepare(
    `INSERT INTO legacy_narratives
       (narrative_id, session_id, verification_status, verification_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(narrative_id) DO UPDATE SET
       verification_status = excluded.verification_status,
       verification_json = excluded.verification_json`,
  ).run(
    input.narrativeId,
    input.sessionId,
    input.verificationStatus,
    input.verificationJson,
    input.createdAt.toISOString(),
  );
}

/** The ACK owns the retirement time; raw world and graph knowledge fields are preserved. */
export function retireLegacyNarrative(
  db: SqliteHandle,
  input: {
    readonly narrativeId: string;
    readonly sessionId: string;
    readonly operationId: string;
    readonly knownFrom: string;
    readonly chunkIds: readonly string[];
    readonly cohortId: string;
  },
): void {
  if (!db.inTransaction) {
    throw new Error('legacy retirement requires its acknowledgment transaction');
  }
  const held = readLegacyNarrative(db, input.narrativeId);
  if (held?.sessionId !== input.sessionId) {
    throw new Error('legacy retirement has no matching identity record');
  }
  const retirement = JSON.stringify({
    operationId: input.operationId,
    family: 'chunk',
    cohortId: input.cohortId,
    chunkIds: [...input.chunkIds].sort(),
  });
  if (held.retiredAt !== null) {
    if (held.retiredAt !== input.knownFrom || held.retirementFamilyJson !== retirement) {
      throw new Error('legacy retirement is already bound to another publication');
    }
    return;
  }
  db.prepare(
    'UPDATE legacy_narratives SET retired_at = ?, retirement_family_json = ? WHERE narrative_id = ?',
  ).run(input.knownFrom, retirement, input.narrativeId);
}

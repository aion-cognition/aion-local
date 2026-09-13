import type { SqliteHandle } from './database.js';

/** A session has one default narrative representation at each knowledge-time vantage. */
export type SessionNarrativeFamily = 'chunk';

export type FamilySelection = {
  readonly sessionId: string;
  readonly version: number;
  readonly family: SessionNarrativeFamily;
  readonly operationId: string;
  readonly knownFrom: string;
};

type SelectionRow = {
  session_id: string;
  version: number;
  active_family: string;
  operation_id: string;
  known_from: string;
};

/**
 * Reads the acknowledged preference at the requested knowledge time. World time selects the
 * contents of a representation; it never chooses which representation was known.
 */
function selectFamily(
  db: SqliteHandle,
  sessionId: string,
  knewAt: Date | undefined,
  order: 'ASC' | 'DESC',
): FamilySelection | undefined {
  const row = db
    .prepare(
      `SELECT f.session_id, f.version, f.active_family, f.operation_id, i.known_from
         FROM family_selection_log f
         JOIN publication_intents i ON i.operation_id = f.operation_id
        WHERE f.session_id = ? AND i.state = 'acknowledged' AND i.known_from IS NOT NULL
          AND (? IS NULL OR i.known_from <= ?)
        ORDER BY f.version ${order} LIMIT 1`,
    )
    .get(sessionId, knewAt?.toISOString() ?? null, knewAt?.toISOString() ?? null) as
    SelectionRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  if (row.active_family !== 'chunk') {
    throw new Error(`unknown narrative family ${row.active_family}`);
  }
  return {
    sessionId: row.session_id,
    version: row.version,
    family: row.active_family,
    operationId: row.operation_id,
    knownFrom: row.known_from,
  };
}

/** The current acknowledged choice at a pinned knowledge vantage, or the present choice. */
export function readFamilySelection(
  db: SqliteHandle,
  sessionId: string,
  knewAt?: Date,
): FamilySelection | undefined {
  return selectFamily(db, sessionId, knewAt, 'DESC');
}

/** The first acknowledged choice bounds the period before preference recording existed. */
export function readFirstFamilySelection(
  db: SqliteHandle,
  sessionId: string,
): FamilySelection | undefined {
  return selectFamily(db, sessionId, undefined, 'ASC');
}

/**
 * Appends a preference inside its publication's acknowledgment transaction. The intent's ACK
 * makes this row visible, so the preference and the rest of that publication appear together.
 */
export function acknowledgeFamilySelection(
  db: SqliteHandle,
  input: {
    readonly sessionId: string;
    readonly expectedVersion: number;
    readonly family: SessionNarrativeFamily;
    readonly operationId: string;
  },
): number {
  if (!db.inTransaction) {
    throw new Error('family selection requires its acknowledgment transaction');
  }
  const repeated = db
    .prepare(
      `SELECT version, active_family FROM family_selection_log
        WHERE session_id = ? AND operation_id = ?`,
    )
    .get(input.sessionId, input.operationId) as
    { version: number; active_family: string } | undefined;
  if (repeated !== undefined) {
    if (repeated.version !== input.expectedVersion + 1 || repeated.active_family !== input.family) {
      throw new Error('family selection operation changed its recorded preference');
    }
    return repeated.version;
  }
  const current = readFamilySelection(db, input.sessionId);
  if ((current?.version ?? 0) !== input.expectedVersion) {
    throw new Error('family selection moved before acknowledgment');
  }
  const version = input.expectedVersion + 1;
  db.prepare(
    `INSERT INTO family_selection_log (session_id, version, active_family, operation_id)
     VALUES (?, ?, ?, ?)`,
  ).run(input.sessionId, version, input.family, input.operationId);
  return version;
}

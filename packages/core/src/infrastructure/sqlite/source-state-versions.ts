import type { SqliteHandle } from './database.js';

/**
 * What somebody stated about a source, as opposed to where its bytes are kept.
 *
 * Split out of the residency record it used to sit beside, because the two answer different
 * questions with different lifetimes. Residency is operational and moves with storage; a statement
 * is evidence and outlives whatever it was about. A forget is never read off residency, and an
 * eviction never reads as a forget.
 */

/**
 * Statements about the source itself: a forget, a suppression, an unforget.
 *
 * Append-only in the committed view, which is the view every reader here works in. A row carrying
 * a `known_from` is never rewritten and never removed, so the record of a forget survives whatever
 * replaced the content it was about and a reversal is a later statement, not an erasure. A row
 * still waiting for that column is not in the view and is released rather than kept: see
 * `releasePreparedSourceStateVersions` for why it is not a statement about anything.
 */
export type SourceStateKind = 'forgotten' | 'unforgotten' | 'suppressed' | 'unsuppressed';

export type SourceStateVersion = {
  readonly sourceId: string;
  readonly version: number;
  readonly stateKind: SourceStateKind;
  readonly operationId: string;
  readonly knownFrom: string | null;
  readonly observedAt: string;
};

type StateRowData = {
  source_id: string;
  version: number;
  state_kind: SourceStateKind;
  operation_id: string;
  known_from: string | null;
  observed_at: string;
};

function toStateVersion(row: StateRowData): SourceStateVersion {
  return {
    sourceId: row.source_id,
    version: row.version,
    stateKind: row.state_kind,
    operationId: row.operation_id,
    knownFrom: row.known_from,
    observedAt: row.observed_at,
  };
}

export type SourceStateInput = {
  readonly sourceId: string;
  readonly stateKind: SourceStateKind;
  readonly operationId: string;
  readonly observedAt: Date;
  readonly knownFrom?: Date;
  readonly detail?: Record<string, unknown>;
};

/** Appends one statement about a source and returns the version it took. */
export function recordSourceStateVersion(db: SqliteHandle, input: SourceStateInput): number {
  return db
    .transaction((): number => {
      const high = db
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS n FROM source_state_versions WHERE source_id = ?',
        )
        .get(input.sourceId) as { n: number };
      const version = high.n + 1;
      db.prepare(
        `INSERT INTO source_state_versions
           (source_id, version, state_kind, operation_id, known_from, observed_at, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sourceId,
        version,
        input.stateKind,
        input.operationId,
        input.knownFrom?.toISOString() ?? null,
        input.observedAt.toISOString(),
        input.detail === undefined ? null : JSON.stringify(input.detail),
      );
      return version;
    })
    .immediate();
}

export function listSourceStateVersions(
  db: SqliteHandle,
  sourceId: string,
): readonly SourceStateVersion[] {
  const rows = db
    .prepare(
      `SELECT source_id, version, state_kind, operation_id, known_from, observed_at
       FROM source_state_versions WHERE source_id = ? ORDER BY version`,
    )
    .all(sourceId) as StateRowData[];
  return rows.map(toStateVersion);
}

/**
 * Whether the newest ACKNOWLEDGED forget statement on a source still stands.
 *
 * Read off the latest statement of either kind rather than off a flag, so an unforget is a
 * statement in the same chain instead of an erasure of the one before it. Versions with no
 * `known_from` are outside this answer: they are durable and invisible at the same time, and a
 * prepared write that its publication later rejects would otherwise have decided that the
 * source was gone. `listSourceStateVersions` still shows them.
 */
export function isSourceForgotten(db: SqliteHandle, sourceId: string): boolean {
  return committedForget(db, sourceId) !== undefined;
}

/** The statement a forget disposition rests on, so a row can record which one closed it. */
export type CommittedForget = {
  readonly version: number;
  readonly knownFrom: string;
};

/**
 * The newest committed forget statement on a source, when that is what still stands.
 *
 * One reader for every caller that turns on whether a source is gone, so the predicate cannot
 * drift between the census that counts and the settlement that closes rows against it.
 *
 * Committed means the same thing here as everywhere else in the committed view: the statement's
 * own operation is acknowledged. A `known_from` is a timestamp somebody wrote, and a publication
 * that was later refused would otherwise have decided the source was gone.
 */
export function committedForget(db: SqliteHandle, sourceId: string): CommittedForget | undefined {
  const row = db
    .prepare(
      `SELECT s.state_kind, s.version, s.known_from FROM source_state_versions s
       JOIN publication_intents i ON i.operation_id = s.operation_id AND i.state = 'acknowledged'
       WHERE s.source_id = ? AND s.state_kind IN ('forgotten','unforgotten')
         AND s.known_from IS NOT NULL
       ORDER BY s.version DESC LIMIT 1`,
    )
    .get(sourceId) as
    { state_kind: SourceStateKind; version: number; known_from: string } | undefined;
  if (row?.state_kind !== 'forgotten') {
    return undefined;
  }
  return { version: row.version, knownFrom: row.known_from };
}

/**
 * Whether a statement about this source is prepared and not yet acknowledged. A caller whose
 * decision turns on the source's state cannot make it while one is outstanding: the answer is
 * about to move and nothing here can say which way.
 */
export function hasPendingSourceState(db: SqliteHandle, sourceId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM source_state_versions
         WHERE source_id = ? AND known_from IS NULL LIMIT 1`,
      )
      .get(sourceId) !== undefined
  );
}

/** Promotes every state version one publication prepared into the committed view. */
export function acknowledgeSourceStateVersions(
  db: SqliteHandle,
  operationId: string,
  knownFrom: string,
): number {
  return db
    .prepare(
      `UPDATE source_state_versions SET known_from = ?
       WHERE operation_id = ? AND known_from IS NULL`,
    )
    .run(knownFrom, operationId).changes;
}

/**
 * Drops the statements one rejected operation prepared and nothing can ever adopt.
 *
 * The one removal this table admits, bounded by `known_from IS NULL` to rows that were never in
 * the committed view. Append-only protects the record of what somebody said, and this row records
 * nothing somebody said: it is an operation's half-written intent, keyed on an identity no retry
 * carries. Left behind, `hasPendingSourceState` reads it as a decision about to move and holds
 * every caller that turns on this source's state, permanently.
 */
export function releasePreparedSourceStateVersions(db: SqliteHandle, operationId: string): number {
  return db
    .prepare('DELETE FROM source_state_versions WHERE operation_id = ? AND known_from IS NULL')
    .run(operationId).changes;
}

import type { SqliteHandle } from './database.js';

/**
 * Where a source's storage sits, and what has been stated about the source itself.
 *
 * The two are apart because they answer different questions. Residency is operational: whether
 * the raw projection is here, on its way out, or gone. A state version is evidence: somebody
 * forgot or suppressed this source at a moment, and that statement outlives whatever it was
 * about. A forget is therefore never read off residency, and an eviction never reads as a
 * forget.
 */
export type SourceResidencyState = 'resident' | 'retiring' | 'evicted';

export type SourceResidency = {
  readonly sourceId: string;
  readonly state: SourceResidencyState;
  readonly projectionGeneration: number;
  readonly activeOperationId: string | null;
  readonly manifestDigest: string | null;
  readonly transitionedAt: string;
  readonly rebuildAckAt: string | null;
};

type ResidencyRowData = {
  source_id: string;
  state: SourceResidencyState;
  projection_generation: number;
  active_operation_id: string | null;
  manifest_digest: string | null;
  transitioned_at: string;
  rebuild_ack_at: string | null;
};

const SELECT_RESIDENCY = `SELECT source_id, state, projection_generation, active_operation_id,
    manifest_digest, transitioned_at, rebuild_ack_at
  FROM source_residency`;

function toResidency(row: ResidencyRowData): SourceResidency {
  return {
    sourceId: row.source_id,
    state: row.state,
    projectionGeneration: row.projection_generation,
    activeOperationId: row.active_operation_id,
    manifestDigest: row.manifest_digest,
    transitionedAt: row.transitioned_at,
    rebuildAckAt: row.rebuild_ack_at,
  };
}

export function readSourceResidency(
  db: SqliteHandle,
  sourceId: string,
): SourceResidency | undefined {
  const row = db.prepare(`${SELECT_RESIDENCY} WHERE source_id = ?`).get(sourceId) as
    ResidencyRowData | undefined;
  return row === undefined ? undefined : toResidency(row);
}

/**
 * A source with no row of its own is resident: the raw projection was written and nothing has
 * moved it. Reading absence as unknown would make every source that predates this table look
 * like one whose storage nobody can account for.
 */
export function sourceResidencyState(db: SqliteHandle, sourceId: string): SourceResidencyState {
  return readSourceResidency(db, sourceId)?.state ?? 'resident';
}

export type ResidencyTransition = {
  readonly sourceId: string;
  readonly state: SourceResidencyState;
  readonly operationId: string;
  readonly manifestDigest?: string;
  readonly transitionedAt: Date;
  readonly rebuildAckAt?: Date;
};

/**
 * Moves a source's storage and takes the next projection generation for the attempt.
 *
 * The generation advances on the attempt rather than on the outcome, so a transition that
 * failed leaves its number spent. A retry therefore projects under a number nothing else ever
 * used, and a stale worker holding the old one cannot write into the retry's place.
 *
 * Returns the generation this transition owns.
 */
export function transitionSourceResidency(
  db: SqliteHandle,
  transition: ResidencyTransition,
): number {
  return db
    .transaction((): number => {
      const current = readSourceResidency(db, transition.sourceId);
      const projectionGeneration = (current?.projectionGeneration ?? 0) + 1;
      db.prepare(
        `INSERT INTO source_residency
           (source_id, state, projection_generation, active_operation_id, manifest_digest,
            transitioned_at, rebuild_ack_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id) DO UPDATE SET
           state = excluded.state,
           projection_generation = excluded.projection_generation,
           active_operation_id = excluded.active_operation_id,
           manifest_digest = excluded.manifest_digest,
           transitioned_at = excluded.transitioned_at,
           rebuild_ack_at = COALESCE(excluded.rebuild_ack_at, source_residency.rebuild_ack_at)`,
      ).run(
        transition.sourceId,
        transition.state,
        projectionGeneration,
        transition.operationId,
        transition.manifestDigest ?? null,
        transition.transitionedAt.toISOString(),
        transition.rebuildAckAt?.toISOString() ?? null,
      );
      return projectionGeneration;
    })
    .immediate();
}

/**
 * Settles the state of a transition that already took its generation. It moves nothing unless
 * the row still carries that generation, so an acknowledgment arriving after a later attempt
 * replaced it changes nothing: the attempt it belongs to is over.
 *
 * Returns whether the state moved.
 */
export function settleSourceResidency(
  db: SqliteHandle,
  settlement: {
    readonly sourceId: string;
    readonly state: SourceResidencyState;
    readonly projectionGeneration: number;
    readonly operationId: string;
    readonly transitionedAt: Date;
    readonly rebuildAckAt?: Date;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE source_residency
         SET state = ?, transitioned_at = ?, rebuild_ack_at = COALESCE(?, rebuild_ack_at)
         WHERE source_id = ? AND projection_generation = ? AND active_operation_id = ?`,
      )
      .run(
        settlement.state,
        settlement.transitionedAt.toISOString(),
        settlement.rebuildAckAt?.toISOString() ?? null,
        settlement.sourceId,
        settlement.projectionGeneration,
        settlement.operationId,
      ).changes === 1
  );
}

/**
 * Statements about the source itself: a forget, a suppression, an unforget. Append-only, so the
 * record of a forget survives whatever replaced the content it was about.
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
 * A version is keyed on the operation that wrote it, so a retry under a new identity takes a new
 * row and leaves this one owed by an operation that will never acknowledge. Nothing was in the
 * committed view, and `hasPendingSourceState` reads an unacknowledged row as a decision about to
 * move — left behind it would hold every caller that turns on the source's state, permanently.
 */
export function releasePreparedSourceStateVersions(db: SqliteHandle, operationId: string): number {
  return db
    .prepare('DELETE FROM source_state_versions WHERE operation_id = ? AND known_from IS NULL')
    .run(operationId).changes;
}

/**
 * Per-effect acknowledgment for one accepted reference batch. Raw reconstruction and semantic
 * processing are different obligations, so they never share a row and one completing says
 * nothing about the other.
 */
export const RAW_REBUILD_EFFECT = 'raw_rebuild';
export const SEMANTIC_PROCESSING_EFFECT = 'semantic_processing';
export const SOURCE_INDEX_EFFECT = 'source_index';

export type EvidenceAcknowledgment = {
  readonly sourceId: string;
  readonly referenceVersion: number;
  readonly effectKind: string;
  readonly state: string;
  readonly completedAt: string | null;
};

export type AcknowledgmentInput = {
  readonly sourceId: string;
  readonly referenceVersion: number;
  readonly effectKind: string;
  readonly state: 'owed' | 'completed';
  readonly completedAt?: Date;
  readonly detail?: Record<string, unknown>;
};

/**
 * Records what one accepted reference version owes, or that it has been discharged. An owed row
 * is never overwritten by a second owed row, so a repeated preparation leaves the obligation
 * exactly where it was.
 */
export function recordEvidenceAcknowledgment(db: SqliteHandle, input: AcknowledgmentInput): void {
  db.prepare(
    `INSERT INTO evidence_acknowledgments
       (source_id, reference_version, effect_kind, state, completed_at, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, reference_version, effect_kind) DO UPDATE SET
       state = excluded.state,
       completed_at = COALESCE(excluded.completed_at, evidence_acknowledgments.completed_at),
       detail_json = COALESCE(excluded.detail_json, evidence_acknowledgments.detail_json)
     WHERE evidence_acknowledgments.state != 'completed'`,
  ).run(
    input.sourceId,
    input.referenceVersion,
    input.effectKind,
    input.state,
    input.completedAt?.toISOString() ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  );
}

/** Where an owed-acknowledgment page left off: the last row's key, in the order below. */
export type OwedSignalCursor = {
  readonly sourceId: string;
  readonly referenceVersion: number;
};

/**
 * Still-owed acknowledgments of one effect kind, across every source, bounded and resumable.
 *
 * The order is source id then reference version, which is a stable enumeration order and NOT an
 * age order: a source id is a minted identifier, not a clock. What the order has to be is total
 * and repeatable, so a caller paging on the last row it saw visits every owed key rather than the
 * same first page forever. An obligation nobody reads is an obligation nobody discharges, and one
 * permanently stuck page in front of the rest is the same thing.
 *
 * `after` selects strictly past that key. Reading past a row changes nothing about it: an
 * obligation is discharged by its own settlement and never by a page moving on.
 */
export function listOwedEvidenceAcknowledgments(
  db: SqliteHandle,
  effectKind: string,
  limit: number,
  after?: OwedSignalCursor,
): readonly EvidenceAcknowledgment[] {
  const keyset = after === undefined ? '' : 'AND (source_id, reference_version) > (?, ?)';
  const parameters =
    after === undefined
      ? [effectKind, limit]
      : [effectKind, after.sourceId, after.referenceVersion, limit];
  const rows = db
    .prepare(
      `SELECT source_id, reference_version, effect_kind, state, completed_at
       FROM evidence_acknowledgments
       WHERE effect_kind = ? AND state = 'owed' ${keyset}
       ORDER BY source_id, reference_version
       LIMIT ?`,
    )
    .all(...parameters) as {
    source_id: string;
    reference_version: number;
    effect_kind: string;
    state: string;
    completed_at: string | null;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    referenceVersion: row.reference_version,
    effectKind: row.effect_kind,
    state: row.state,
    completedAt: row.completed_at,
  }));
}

export function listEvidenceAcknowledgments(
  db: SqliteHandle,
  sourceId: string,
): readonly EvidenceAcknowledgment[] {
  const rows = db
    .prepare(
      `SELECT source_id, reference_version, effect_kind, state, completed_at
       FROM evidence_acknowledgments WHERE source_id = ?
       ORDER BY reference_version, effect_kind`,
    )
    .all(sourceId) as {
    source_id: string;
    reference_version: number;
    effect_kind: string;
    state: string;
    completed_at: string | null;
  }[];
  return rows.map((row) => ({
    sourceId: row.source_id,
    referenceVersion: row.reference_version,
    effectKind: row.effect_kind,
    state: row.state,
    completedAt: row.completed_at,
  }));
}

/**
 * Where a source sits in the live ingest order, as a value two sources can be compared on.
 * Zero-padded because the column is text and an unpadded number would sort 10 before 9.
 */
export function captureOrderValue(position: number): string {
  return String(position).padStart(16, '0');
}

/**
 * How far the session's unsealed tail reaches. Only the watermark is stored: the remainder is
 * the session's sources minus the ones already sealed into chunks, and a second copy of that
 * membership could disagree with the first.
 *
 * It only ever moves forward. A late acceptance whose ingest position is behind the mark has
 * already been accounted for by whatever moved it there.
 */
export function touchSessionRemainder(
  db: SqliteHandle,
  sessionId: string,
  watermark: string,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO session_remainders (session_id, watermark, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       watermark = MAX(session_remainders.watermark, excluded.watermark),
       updated_at = excluded.updated_at`,
  ).run(sessionId, watermark, now.toISOString());
}

export function readSessionRemainder(db: SqliteHandle, sessionId: string): string | undefined {
  const row = db
    .prepare('SELECT watermark FROM session_remainders WHERE session_id = ?')
    .get(sessionId) as { watermark: string } | undefined;
  return row?.watermark;
}

import type { SqliteHandle } from './database.js';

/**
 * The durable record of a publication: what it was asked to do, what it returned, and when it
 * became visible.
 *
 * The graph guard keeps only the newest receipt, so an operation whose receipt a later one
 * overwrote there has nothing to answer a retry from. This table answers it instead: every
 * acknowledged operation keeps its own result and clocks for good, and a retry reads its
 * recorded outcome back rather than inferring one from a graph that has moved on.
 */
export type PublicationIntent = {
  readonly operationId: string;
  readonly kind: string;
  readonly payloadDigest: string;
  /** The prepared input, durable before the graph is touched. Never overwritten by the result. */
  readonly payloadJson: string;
  readonly affectedScopesJson: string;
  readonly expectedJson: string;
  readonly preparedActionsJson: string;
  readonly createdAt: Date;
};

export type PublicationIntentReceipt = {
  readonly sequence: string;
  readonly operationId: string;
  readonly kind: string;
  readonly state: 'prepared' | 'acknowledged' | 'deferred' | 'rejected';
  readonly resultDigest: string | null;
  readonly resultJson: string | null;
  readonly knownFrom: string | null;
  readonly observedAckAt: string | null;
  /** True when the visibility clock was held back to a predecessor's rather than the wall clock. */
  readonly clockClamped: boolean;
  readonly error: string | null;
};

type ReceiptRowData = {
  sequence: string;
  operation_id: string;
  kind: string;
  state: PublicationIntentReceipt['state'];
  result_digest: string | null;
  result_json: string | null;
  known_from: string | null;
  observed_ack_at: string | null;
  clock_clamped: number;
  error: string | null;
};

const SELECT_RECEIPT = `SELECT CAST(sequence AS TEXT) AS sequence, operation_id, kind, state, result_digest, result_json,
    known_from, observed_ack_at, clock_clamped, error
  FROM publication_intents WHERE operation_id = ?`;

function toReceipt(row: ReceiptRowData): PublicationIntentReceipt {
  return {
    sequence: row.sequence,
    operationId: row.operation_id,
    kind: row.kind,
    state: row.state,
    resultDigest: row.result_digest,
    resultJson: row.result_json,
    knownFrom: row.known_from,
    observedAckAt: row.observed_ack_at,
    clockClamped: row.clock_clamped === 1,
    error: row.error,
  };
}

/**
 * Writes the intent and allocates its sequence in one step. `AUTOINCREMENT` never hands out a
 * committed number twice. A number taken inside a transaction that then rolls back goes back
 * with it, and the next prepare takes that number again, so non-reuse covers committed
 * allocations and nothing else.
 *
 * That is enough because an allocation has to commit before anything outside uses it, and the
 * durability boundary is the outermost transaction rather than this call: a caller that nests
 * this helper must not expose the sequence it returns until its own transaction commits.
 *
 * Preparing the same operation twice returns the sequence it already has: a retry of a prepare
 * is a caller repeating itself.
 */
export function preparePublicationIntent(db: SqliteHandle, intent: PublicationIntent): string {
  return db
    .transaction((): string => {
      const existing = db.prepare(SELECT_RECEIPT).get(intent.operationId) as
        ReceiptRowData | undefined;
      if (existing !== undefined) {
        return existing.sequence;
      }
      const result = db
        .prepare(
          `INSERT INTO publication_intents
             (operation_id, kind, payload_digest, payload_json, affected_scopes_json, expected_json,
              prepared_actions_json, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
        )
        .safeIntegers(true)
        .run(
          intent.operationId,
          intent.kind,
          intent.payloadDigest,
          intent.payloadJson,
          intent.affectedScopesJson,
          intent.expectedJson,
          intent.preparedActionsJson,
          intent.createdAt.toISOString(),
        );
      return result.lastInsertRowid.toString();
    })
    .immediate();
}

export type PublicationAcknowledgment = {
  readonly operationId: string;
  readonly resultDigest: string;
  /** The outcome itself, or an exact typed reference to it. A digest alone cannot reproduce it. */
  readonly resultJson: string;
  /** The wall clock when the acknowledgment was observed. */
  readonly observedAckAt: Date;
};

/**
 * Records the outcome and assigns the visibility clock.
 *
 * The clock is the later of the observed wall time and the previous acknowledgment's, so a
 * host clock that stepped backwards cannot make a newer publication visible earlier than an
 * older one. When it is held back, `clock_clamped` records that, and the observed wall time is
 * kept beside it rather than replaced: the committed view orders on the visibility clock and
 * the sequence, and the wall time stays readable for anyone asking what the host believed.
 *
 * Acknowledging an operation that is already acknowledged returns its recorded receipt
 * untouched.
 */
export function acknowledgePublicationIntent(
  db: SqliteHandle,
  acknowledgment: PublicationAcknowledgment,
): PublicationIntentReceipt {
  return db
    .transaction((): PublicationIntentReceipt => {
      const current = db.prepare(SELECT_RECEIPT).get(acknowledgment.operationId) as
        ReceiptRowData | undefined;
      if (current === undefined) {
        throw new Error(`publication ${acknowledgment.operationId} was never prepared`);
      }
      if (current.state === 'acknowledged') {
        return toReceipt(current);
      }
      if (current.state !== 'prepared') {
        throw new Error(
          `publication ${acknowledgment.operationId} is ${current.state} and cannot acknowledge`,
        );
      }

      const predecessor = db
        .prepare(
          `SELECT known_from FROM publication_intents WHERE state = 'acknowledged'
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get() as { known_from: string } | undefined;
      const observedAckAt = acknowledgment.observedAckAt.toISOString();
      const clamped = predecessor !== undefined && predecessor.known_from > observedAckAt;
      const knownFrom = clamped ? predecessor.known_from : observedAckAt;

      db.prepare(
        `UPDATE publication_intents
         SET state = 'acknowledged', result_digest = ?, result_json = ?, known_from = ?,
             observed_ack_at = ?, clock_clamped = ?, acknowledged_at = ?
         WHERE operation_id = ?`,
      ).run(
        acknowledgment.resultDigest,
        acknowledgment.resultJson,
        knownFrom,
        observedAckAt,
        clamped ? 1 : 0,
        observedAckAt,
        acknowledgment.operationId,
      );

      return {
        sequence: current.sequence,
        operationId: current.operation_id,
        kind: current.kind,
        state: 'acknowledged',
        resultDigest: acknowledgment.resultDigest,
        resultJson: acknowledgment.resultJson,
        knownFrom,
        observedAckAt,
        clockClamped: clamped,
        error: current.error,
      };
    })
    .immediate();
}

/**
 * Ends a prepared operation without acknowledging it. A deferred operation may be retried
 * under a fresh operation id; a rejected one will not be. Neither removes anything from the
 * committed view, because nothing a prepared operation wrote was ever in it.
 */
export function settleUnacknowledgedIntent(
  db: SqliteHandle,
  operationId: string,
  state: 'deferred' | 'rejected',
  error: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE publication_intents SET state = ?, error = ?
       WHERE operation_id = ? AND state = 'prepared'`,
    )
    .run(state, error, operationId);
  return result.changes === 1;
}

export function readPublicationReceipt(
  db: SqliteHandle,
  operationId: string,
): PublicationIntentReceipt | undefined {
  const row = db.prepare(SELECT_RECEIPT).get(operationId) as ReceiptRowData | undefined;
  return row === undefined ? undefined : toReceipt(row);
}

/**
 * The publications one source's own durable records name, newest evidence last.
 *
 * Three bindings reach them, and each one is a record a writer made about this source rather
 * than text that happens to mention it: the stated links whose origin it is, the statements
 * made about its own state, and the effect an operation declared against it by id. The third
 * is what an ordinary capture leaves behind. A push that stated no references writes neither a
 * link version nor a state statement, and its acceptance still names the source it elected, so
 * without that binding a source's own arrival is missing from its history. An effect naming
 * something else, a survivor or a node, binds nothing here.
 *
 * `created_at` rides along so a prepared intent can be placed without inventing a clock it
 * never had: an unacknowledged row has no knowledge time by construction, and giving it one
 * would report an input as published evidence.
 *
 * Ordered the way visibility is: the knowledge clock first, then the sequence. A prepared row
 * sorts on its own creation, after everything acknowledged before it.
 */
export function listSourcePublications(
  db: SqliteHandle,
  sourceId: string,
): readonly SourcePublication[] {
  const rows = db
    .prepare(
      `SELECT CAST(p.sequence AS TEXT) AS sequence, p.operation_id, p.kind, p.state,
              p.result_digest, p.result_json, p.known_from, p.observed_ack_at, p.clock_clamped,
              p.error, p.created_at
       FROM publication_intents p
       WHERE p.operation_id IN (
         SELECT v.operation_id FROM evidence_link_versions v
           JOIN evidence_links l ON l.link_id = v.link_id
          WHERE l.from_id = ? AND v.operation_id IS NOT NULL
         UNION
         SELECT s.operation_id FROM source_state_versions s WHERE s.source_id = ?
         UNION
         SELECT e.operation_id FROM publication_effects e
          WHERE json_extract(e.detail_json, '$.sourceId') = ?
       )
       ORDER BY COALESCE(p.known_from, p.created_at), p.sequence`,
    )
    .all(sourceId, sourceId, sourceId) as (ReceiptRowData & { created_at: string })[];
  return rows.map((row) => ({ ...toReceipt(row), createdAt: row.created_at }));
}

/** A receipt with the moment its intent was written, which is all a prepared row can be placed by. */
export type SourcePublication = PublicationIntentReceipt & {
  readonly createdAt: string;
};

/** The committed-view predicate: a semantic row counts once its owning operation is acknowledged. */
export function isOperationAcknowledged(db: SqliteHandle, operationId: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM publication_intents WHERE operation_id = ? AND state = 'acknowledged'",
    )
    .get(operationId);
  return row !== undefined;
}

/**
 * The state one operation's intent records, or undefined when nothing here accounts for it.
 *
 * Absent and refused are different answers and a caller that turns on one has to be able to tell
 * them apart: an operation nobody can account for is not an operation that was answered.
 */
export function publicationIntentState(
  db: SqliteHandle,
  operationId: string,
): PublicationIntentReceipt['state'] | undefined {
  const row = db
    .prepare('SELECT state FROM publication_intents WHERE operation_id = ?')
    .get(operationId) as { state: PublicationIntentReceipt['state'] } | undefined;
  return row?.state;
}

/** Acknowledged operations in visibility order, which is the clock first and the sequence after it. */
export function listAcknowledgedOperations(db: SqliteHandle): readonly PublicationIntentReceipt[] {
  const rows = db
    .prepare(
      `SELECT CAST(sequence AS TEXT) AS sequence, operation_id, kind, state, result_digest, result_json, known_from,
              observed_ack_at, clock_clamped, error
       FROM publication_intents WHERE state = 'acknowledged'
       ORDER BY known_from, sequence`,
    )
    .all() as ReceiptRowData[];
  return rows.map(toReceipt);
}

export type PublicationEffect = {
  readonly operationId: string;
  readonly effectKind: string;
  /**
   * The typed binding this effect declares. A `sourceId` key here is what ties the operation to
   * that source's publication history, so an effect about a source names it under that key.
   */
  readonly detailJson?: string;
};

/** Records an effect the operation owes. Repeating it leaves the recorded state alone. */
export function recordPendingEffect(db: SqliteHandle, effect: PublicationEffect): void {
  db.prepare(
    `INSERT INTO publication_effects (operation_id, effect_kind, state, detail_json)
     VALUES (?, ?, 'pending', ?)
     ON CONFLICT (operation_id, effect_kind) DO NOTHING`,
  ).run(effect.operationId, effect.effectKind, effect.detailJson ?? null);
}

/** Marks one effect complete. Returns false when it was already complete. */
export function completeEffect(
  db: SqliteHandle,
  operationId: string,
  effectKind: string,
  completedAt: Date,
): boolean {
  const result = db
    .prepare(
      `UPDATE publication_effects SET state = 'complete', completed_at = ?
       WHERE operation_id = ? AND effect_kind = ? AND state = 'pending'`,
    )
    .run(completedAt.toISOString(), operationId, effectKind);
  return result.changes === 1;
}

/** The effect kinds this operation still owes. A recovery finishes these rather than replaying. */
export function listPendingEffects(db: SqliteHandle, operationId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT effect_kind FROM publication_effects
       WHERE operation_id = ? AND state = 'pending' ORDER BY effect_kind`,
    )
    .all(operationId) as { effect_kind: string }[];
  return rows.map((row) => row.effect_kind);
}

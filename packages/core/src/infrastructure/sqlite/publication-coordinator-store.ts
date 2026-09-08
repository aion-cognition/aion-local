import type { SqliteHandle } from './database.js';
import {
  acknowledgePublicationIntent,
  completeEffect,
  preparePublicationIntent,
  recordPendingEffect,
  settleUnacknowledgedIntent,
} from './publication-intents.js';
import { PublicationInvariantError } from '../publication/errors.js';
import {
  canonicalJson,
  comparePublicationKeys,
  decimalSequence,
  parseJson,
  publicationDigest,
  publicationTimestamp,
} from '../publication/json.js';
import { validatePublicationEffects } from '../publication/operation.js';
import {
  parseAffectedScopes,
  parsePublicationPreconditions,
} from '../publication/preconditions.js';
import type {
  JsonValue,
  PublicationHandler,
  PublicationKind,
  PublicationOutcome,
  PublicationPlan,
  PublicationStamp,
} from '../publication/types.js';

export type CoordinatorControl = {
  readonly substrateId: string;
  readonly protocolVersion: number;
  readonly bootstrapState: string;
  readonly lastAckSequence: string;
  readonly pendingOperationId: string | null;
  readonly lastKnownFrom: string | null;
};
export type PublicationRecord = {
  readonly sequence: string;
  readonly operationId: string;
  readonly kind: string;
  readonly payloadDigest: string;
  readonly payloadJson: string;
  readonly expectedJson: string;
  readonly actionsJson: string;
  readonly scopesJson: string;
  readonly state: 'prepared' | 'acknowledged' | 'deferred' | 'rejected';
  readonly resultJson: string | null;
  readonly resultDigest: string | null;
  readonly knownFrom: string | null;
  readonly observedAckAt: string | null;
  readonly clockClamped: number;
  readonly error: string | null;
};

const RECORD_COLUMNS = `CAST(sequence AS TEXT) AS sequence, operation_id AS operationId,
  kind, payload_digest AS payloadDigest, payload_json AS payloadJson,
  expected_json AS expectedJson, prepared_actions_json AS actionsJson,
  affected_scopes_json AS scopesJson, state, result_json AS resultJson,
  result_digest AS resultDigest, known_from AS knownFrom, observed_ack_at AS observedAckAt,
  clock_clamped AS clockClamped, error`;

/** Decimal text avoids rounding SQLite's 64-bit publication ordering through a JS number. */
export function coordinatorControl(db: SqliteHandle): CoordinatorControl {
  const rows = db
    .prepare(
      `SELECT substrate_id AS substrateId, protocol_version AS protocolVersion,
      bootstrap_state AS bootstrapState, CAST(last_ack_sequence AS TEXT) AS lastAckSequence,
      pending_operation_id AS pendingOperationId, last_known_from AS lastKnownFrom
    FROM publication_control LIMIT 2`,
    )
    .all() as CoordinatorControl[];
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new PublicationInvariantError('publication_pairing_missing_or_ambiguous');
  }
  decimalSequence(rows[0].lastAckSequence);
  if (rows[0].lastKnownFrom !== null) {
    publicationTimestamp(rows[0].lastKnownFrom);
  }
  return rows[0];
}

export function publicationRecord(
  db: SqliteHandle,
  operationId: string,
): PublicationRecord | undefined {
  const row = db
    .prepare(`SELECT ${RECORD_COLUMNS} FROM publication_intents WHERE operation_id = ?`)
    .get(operationId) as PublicationRecord | undefined;
  if (row !== undefined) {
    decimalSequence(row.sequence);
  }
  return row;
}

export function acknowledgedRecord(
  db: SqliteHandle,
  sequence: string,
): PublicationRecord | undefined {
  return db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM publication_intents
    WHERE sequence = CAST(? AS INTEGER) AND state = 'acknowledged'`,
    )
    .get(sequence) as PublicationRecord | undefined;
}

export function assertPendingSlot(db: SqliteHandle, control: CoordinatorControl): void {
  const prepared = db
    .prepare("SELECT operation_id FROM publication_intents WHERE state = 'prepared' LIMIT 2")
    .all() as { operation_id: string }[];
  if (
    (control.pendingOperationId === null && prepared.length !== 0) ||
    (control.pendingOperationId !== null &&
      (prepared.length !== 1 || prepared[0]?.operation_id !== control.pendingOperationId))
  ) {
    throw new PublicationInvariantError(
      'publication_pending_slot_mismatch',
      control.pendingOperationId ?? undefined,
    );
  }
}

export function storedPlan(
  record: PublicationRecord,
  handler: PublicationHandler,
): PublicationPlan {
  const actions = parseJson(record.actionsJson);
  if (
    actions === null ||
    typeof actions !== 'object' ||
    Array.isArray(actions) ||
    !('data' in actions) ||
    !('effects' in actions) ||
    !Array.isArray(actions.effects)
  ) {
    throw new PublicationInvariantError('publication_plan_unreadable', record.operationId);
  }
  const scopes = parseAffectedScopes(parseJson(record.scopesJson));
  const effects = actions.effects.map((effect: unknown) => {
    if (
      effect === null ||
      typeof effect !== 'object' ||
      !('kind' in effect) ||
      typeof effect.kind !== 'string' ||
      !('detail' in effect)
    ) {
      throw new PublicationInvariantError('publication_effect_unreadable', record.operationId);
    }
    return { kind: effect.kind, detail: parseJson(canonicalJson(effect.detail)) };
  });
  const plan = {
    data: actions.data,
    expected: parsePublicationPreconditions(parseJson(record.expectedJson)),
    scopes,
    effects,
  };
  if (record.payloadDigest !== publicationBindingDigest(record.kind, record.payloadJson, plan)) {
    throw new PublicationInvariantError('publication_intent_corrupt', record.operationId);
  }
  validatePublicationEffects(handler, plan);
  return { ...plan, data: handler.decodeData(plan.data) };
}

export function publicationBindingDigest(
  kind: string,
  payloadJson: string,
  plan: PublicationPlan,
): string {
  return publicationDigest(canonicalJson({ kind, payload: parseJson(payloadJson), plan }));
}

export function prepareCoordinatorRecord(
  db: SqliteHandle,
  input: {
    operationId: string;
    kind: PublicationKind;
    payloadJson: string;
    digest: string;
    plan: PublicationPlan;
    now: Date;
  },
  pending: boolean,
): PublicationRecord {
  preparePublicationIntent(db, {
    operationId: input.operationId,
    kind: input.kind,
    payloadJson: input.payloadJson,
    payloadDigest: input.digest,
    expectedJson: canonicalJson(input.plan.expected),
    affectedScopesJson: canonicalJson(input.plan.scopes),
    preparedActionsJson: canonicalJson({ data: input.plan.data, effects: input.plan.effects }),
    createdAt: input.now,
  });
  const record = publicationRecord(db, input.operationId);
  if (record?.payloadDigest !== input.digest) {
    throw new PublicationInvariantError('publication_prepare_failed', input.operationId);
  }
  if (pending) {
    const changed = db
      .prepare(
        `UPDATE publication_control SET pending_operation_id = ?
      WHERE pending_operation_id IS NULL`,
      )
      .run(input.operationId).changes;
    if (changed !== 1) {
      throw new PublicationInvariantError('publication_already_pending', input.operationId);
    }
    for (const effect of input.plan.effects) {
      recordPendingEffect(db, {
        operationId: input.operationId,
        effectKind: effect.kind,
        detailJson: canonicalJson(effect.detail),
      });
    }
  }
  return record;
}

/** Only a locked, verified predecessor receipt proves that this journal has no committed owner. */
export function clearUncommittedPublicationResult(
  db: SqliteHandle,
  record: PublicationRecord,
  guardSequence: string,
): void {
  const control = coordinatorControl(db);
  if (
    control.lastAckSequence !== guardSequence ||
    control.pendingOperationId !== record.operationId ||
    decimalSequence(guardSequence) >= decimalSequence(record.sequence)
  ) {
    throw new PublicationInvariantError('publication_result_not_discardable', record.operationId);
  }
  const changed = db
    .prepare(
      `UPDATE publication_intents SET result_json = NULL, result_digest = NULL
     WHERE operation_id = ? AND state = 'prepared'`,
    )
    .run(record.operationId).changes;
  if (changed !== 1) {
    throw new PublicationInvariantError('publication_not_prepared', record.operationId);
  }
}

/** Saved while the graph transaction is still open, so a committed receipt has recoverable output. */
export function savePublicationResult(
  db: SqliteHandle,
  record: PublicationRecord,
  result: JsonValue,
): void {
  const resultJson = canonicalJson(result);
  const resultDigest = publicationDigest(resultJson);
  const changed = db
    .prepare(
      `UPDATE publication_intents SET result_json = ?, result_digest = ?
    WHERE operation_id = ? AND state = 'prepared'
      AND (result_digest IS NULL OR (result_digest = ? AND result_json = ?))`,
    )
    .run(resultJson, resultDigest, record.operationId, resultDigest, resultJson).changes;
  if (changed !== 1) {
    throw new PublicationInvariantError('publication_result_changed', record.operationId);
  }
}

export function publicationResult(record: PublicationRecord): JsonValue {
  if (record.resultJson === null || record.resultDigest !== publicationDigest(record.resultJson)) {
    throw new PublicationInvariantError(
      'publication_result_missing_or_corrupt',
      record.operationId,
    );
  }
  return parseJson(record.resultJson);
}

export function publicationOutcome(record: PublicationRecord): PublicationOutcome {
  if (record.state === 'deferred' || record.state === 'rejected') {
    return {
      status: record.state,
      operationId: record.operationId,
      sequence: record.sequence,
      reason: record.error ?? 'unspecified',
    };
  }
  if (
    record.state !== 'acknowledged' ||
    record.knownFrom === null ||
    record.observedAckAt === null
  ) {
    throw new PublicationInvariantError('publication_not_acknowledged', record.operationId);
  }
  publicationTimestamp(record.knownFrom);
  publicationTimestamp(record.observedAckAt);
  return {
    status: 'acknowledged',
    operationId: record.operationId,
    sequence: record.sequence,
    result: publicationResult(record),
    knownFrom: record.knownFrom,
    observedAckAt: record.observedAckAt,
    clockClamped: record.clockClamped === 1,
  };
}

function effectsMatch(db: SqliteHandle, operationId: string, plan: PublicationPlan): void {
  const effects = db
    .prepare(
      `SELECT effect_kind AS kind, detail_json AS detailJson
    FROM publication_effects WHERE operation_id = ? ORDER BY effect_kind`,
    )
    .all(operationId) as { kind: string; detailJson: string | null }[];
  const expected = [...plan.effects].sort((a, b) => comparePublicationKeys(a.kind, b.kind));
  if (
    effects.length !== expected.length ||
    effects.some(
      (effect, index) =>
        effect.kind !== expected[index]?.kind ||
        effect.detailJson !== canonicalJson(expected[index].detail),
    )
  ) {
    throw new PublicationInvariantError('publication_effect_set_changed', operationId);
  }
}

export function acknowledgeCoordinatorRecord(
  db: SqliteHandle,
  record: PublicationRecord,
  plan: PublicationPlan,
  handler: PublicationHandler,
  observedAt: Date,
): PublicationRecord {
  const current = publicationRecord(db, record.operationId);
  if (current?.state === 'acknowledged') {
    return current;
  }
  const control = coordinatorControl(db);
  if (
    control.pendingOperationId !== record.operationId ||
    current?.state !== 'prepared' ||
    decimalSequence(record.sequence) <= decimalSequence(control.lastAckSequence)
  ) {
    throw new PublicationInvariantError('publication_ack_order', record.operationId);
  }
  const observedAckAt = observedAt.toISOString();
  const knownFrom =
    control.lastKnownFrom !== null && control.lastKnownFrom > observedAckAt
      ? control.lastKnownFrom
      : observedAckAt;
  const clockClamped = knownFrom !== observedAckAt;
  const stamp: PublicationStamp = {
    observedAckAt,
    clockClamped,
    knownFrom,
  };
  effectsMatch(db, record.operationId, plan);
  const result = publicationResult(current);
  if (current.resultJson === null || current.resultDigest === null) {
    throw new PublicationInvariantError('publication_result_missing', record.operationId);
  }
  const returned = handler.acknowledgeSqlite(
    {
      ...stamp,
      operationId: record.operationId,
      sequence: record.sequence,
      db,
    },
    plan,
    result,
  );
  if (returned !== undefined) {
    throw new PublicationInvariantError('async_sqlite_effect', record.operationId);
  }
  effectsMatch(db, record.operationId, plan);
  for (const effect of plan.effects) {
    completeEffect(db, record.operationId, effect.kind, observedAt);
  }
  acknowledgePublicationIntent(db, {
    operationId: record.operationId,
    resultJson: current.resultJson,
    resultDigest: current.resultDigest,
    observedAckAt: observedAt,
  });
  const acknowledged = publicationRecord(db, record.operationId);
  if (acknowledged?.knownFrom !== stamp.knownFrom) {
    throw new PublicationInvariantError('publication_clock_disagreement', record.operationId);
  }
  const changed = db
    .prepare(
      `UPDATE publication_control SET last_ack_sequence = CAST(? AS INTEGER),
    last_known_from = ?, pending_operation_id = NULL
    WHERE pending_operation_id = ? AND last_ack_sequence = CAST(? AS INTEGER)
      AND substrate_id = ? AND protocol_version = ? AND last_known_from IS ?`,
    )
    .run(
      record.sequence,
      stamp.knownFrom,
      record.operationId,
      control.lastAckSequence,
      control.substrateId,
      control.protocolVersion,
      control.lastKnownFrom,
    ).changes;
  if (changed !== 1) {
    throw new PublicationInvariantError(
      'publication_control_changed_during_ack',
      record.operationId,
    );
  }
  return acknowledged;
}

export function discardCoordinatorRecord(
  db: SqliteHandle,
  record: PublicationRecord,
  state: 'deferred' | 'rejected',
  reason: string,
): PublicationRecord {
  if (!settleUnacknowledgedIntent(db, record.operationId, state, reason)) {
    throw new PublicationInvariantError('publication_not_prepared', record.operationId);
  }
  // The immutable plan retains the audit; these effects never became published obligations.
  db.prepare('DELETE FROM publication_effects WHERE operation_id = ?').run(record.operationId);
  db.prepare(
    'UPDATE publication_intents SET result_json = NULL, result_digest = NULL WHERE operation_id = ?',
  ).run(record.operationId);
  db.prepare(
    'UPDATE publication_control SET pending_operation_id = NULL WHERE pending_operation_id = ?',
  ).run(record.operationId);
  const discarded = publicationRecord(db, record.operationId);
  if (discarded === undefined) {
    throw new PublicationInvariantError('publication_record_missing', record.operationId);
  }
  return discarded;
}

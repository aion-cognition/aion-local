import type { SqliteHandle } from './database.js';
import { getLedgerEntry, markLedgerApplied } from './ops-ledger.js';

/**
 * Writers for the source identity records.
 *
 * A source occurrence is keyed on the episode id the archive already carries, and a source
 * that was forgotten and pushed again gets a second occurrence rather than a rewrite of the
 * first. The archive proof is all-or-nothing: a row that claims verification carries every
 * field of it, and a row that cannot claim it says why instead.
 */
export type SourceVerificationStatus = 'verified' | 'unresolved' | 'pinned';

/** The complete archive proof. A row is verified only when all of it is present. */
export type ArchiveProof = {
  readonly canonicalArchiveId: string;
  readonly archiveSchemaVersion: number;
  readonly identityHash: string;
  readonly verifiedContentDigest: string;
  readonly verificationPolicyVersion: number;
  readonly archivedAt: string;
  /** Other archive rows backing this occurrence. Empty when the canonical row is the only one. */
  readonly aliasArchiveIds?: readonly string[];
};

export type SourceRecordInput = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly verificationStatus: SourceVerificationStatus;
  /** Required whenever the status is not verified: an unexplained pin is not evidence. */
  readonly verificationReason?: string;
  readonly occurredAt: string;
  readonly createdAt: Date;
  readonly archive?: ArchiveProof;
  readonly graphClocksJson?: string;
  /** The ordering value actually used, and which clock it came from. */
  readonly captureOrderValue?: string;
  readonly captureOrderBasis?: 'graph_tx_from' | 'archive_acceptance' | 'pinned';
  readonly origin?: string;
};

export type SourceRecord = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly canonicalArchiveId: string | null;
  readonly aliasArchiveIds: readonly string[];
  readonly archiveSchemaVersion: number | null;
  /** The archive key the occurrence was verified under, which a reader recomputes to check it. */
  readonly identityHash: string | null;
  readonly verifiedContentDigest: string | null;
  readonly verificationPolicyVersion: number | null;
  readonly verificationStatus: SourceVerificationStatus;
  readonly verificationReason: string | null;
  readonly occurredAt: string;
  readonly archivedAt: string | null;
  readonly captureOrderValue: string | null;
  readonly captureOrderBasis: string | null;
  /** When this occurrence was accepted. Its own, even where its bytes are a predecessor's. */
  readonly createdAt: string;
};

type SourceRowData = {
  source_id: string;
  session_id: string;
  canonical_archive_id: string | null;
  archive_aliases_json: string | null;
  archive_schema_version: number | null;
  identity_hash: string | null;
  verified_content_digest: string | null;
  verification_policy_version: number | null;
  verification_status: SourceVerificationStatus;
  verification_reason: string | null;
  occurred_at: string;
  archived_at: string | null;
  capture_order_value: string | null;
  capture_order_basis: string | null;
  created_at: string;
};

/**
 * Writes or refreshes a source occurrence. Keyed on the source id, so re-running a backfill
 * batch changes nothing it has already written. A verified row replaces a pinned one for the
 * same occurrence without changing its identity: verification is evidence about the row, not a
 * different row.
 */
export function recordSourceRecord(db: SqliteHandle, input: SourceRecordInput): void {
  if (input.verificationStatus !== 'verified' && input.verificationReason === undefined) {
    throw new Error(`source ${input.sourceId} is ${input.verificationStatus} with no reason given`);
  }
  if (input.verificationStatus === 'verified' && input.archive === undefined) {
    throw new Error(`source ${input.sourceId} claims verification with no archive proof`);
  }

  db.prepare(
    `INSERT INTO source_records
       (source_id, session_id, canonical_archive_id, archive_aliases_json, archive_schema_version,
        identity_hash, verified_content_digest, verification_policy_version, verification_status,
        verification_reason, occurred_at, archived_at, graph_clocks_json, capture_order_value,
        capture_order_basis, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET
       canonical_archive_id = COALESCE(excluded.canonical_archive_id, canonical_archive_id),
       archive_aliases_json = COALESCE(excluded.archive_aliases_json, archive_aliases_json),
       archive_schema_version = COALESCE(excluded.archive_schema_version, archive_schema_version),
       identity_hash = COALESCE(excluded.identity_hash, identity_hash),
       verified_content_digest = COALESCE(excluded.verified_content_digest,
                                          verified_content_digest),
       verification_policy_version = COALESCE(excluded.verification_policy_version,
                                              verification_policy_version),
       verification_status = excluded.verification_status,
       verification_reason = excluded.verification_reason,
       archived_at = COALESCE(excluded.archived_at, archived_at),
       graph_clocks_json = COALESCE(excluded.graph_clocks_json, graph_clocks_json),
       capture_order_value = COALESCE(excluded.capture_order_value, capture_order_value),
       capture_order_basis = COALESCE(excluded.capture_order_basis, capture_order_basis)`,
  ).run(
    input.sourceId,
    input.sessionId,
    input.archive?.canonicalArchiveId ?? null,
    input.archive?.aliasArchiveIds === undefined
      ? null
      : JSON.stringify([...input.archive.aliasArchiveIds]),
    input.archive?.archiveSchemaVersion ?? null,
    input.archive?.identityHash ?? null,
    input.archive?.verifiedContentDigest ?? null,
    input.archive?.verificationPolicyVersion ?? null,
    input.verificationStatus,
    input.verificationReason ?? null,
    input.occurredAt,
    input.archive?.archivedAt ?? null,
    input.graphClocksJson ?? null,
    input.captureOrderValue ?? null,
    input.captureOrderBasis ?? null,
    input.origin ?? null,
    input.createdAt.toISOString(),
  );
}

const SELECT_SOURCE_RECORD = `SELECT source_id, session_id, canonical_archive_id,
    archive_aliases_json, archive_schema_version, identity_hash, verified_content_digest,
    verification_policy_version, verification_status, verification_reason, occurred_at,
    archived_at, capture_order_value, capture_order_basis, created_at
  FROM source_records`;

function toSourceRecord(row: SourceRowData): SourceRecord {
  return {
    sourceId: row.source_id,
    sessionId: row.session_id,
    canonicalArchiveId: row.canonical_archive_id,
    aliasArchiveIds:
      row.archive_aliases_json === null ? [] : (JSON.parse(row.archive_aliases_json) as string[]),
    archiveSchemaVersion: row.archive_schema_version,
    identityHash: row.identity_hash,
    verifiedContentDigest: row.verified_content_digest,
    verificationPolicyVersion: row.verification_policy_version,
    verificationStatus: row.verification_status,
    verificationReason: row.verification_reason,
    occurredAt: row.occurred_at,
    archivedAt: row.archived_at,
    captureOrderValue: row.capture_order_value,
    captureOrderBasis: row.capture_order_basis,
    createdAt: row.created_at,
  };
}

export function readSourceRecord(db: SqliteHandle, sourceId: string): SourceRecord | undefined {
  const row = db.prepare(`${SELECT_SOURCE_RECORD} WHERE source_id = ?`).get(sourceId) as
    SourceRowData | undefined;
  return row === undefined ? undefined : toSourceRecord(row);
}

export type SourcePartInput = {
  readonly partKind: 'turn' | 'observation' | 'tool_execution';
  readonly ordinal: number;
  /** The original turn id, for turns. Nothing else has one and nothing invents one. */
  readonly turnId?: string;
  /** The role as recorded, or left out. Never inferred from position. */
  readonly role?: string;
  readonly contentHash: string;
  readonly occurredAt?: string;
  readonly graphClocksJson?: string;
};

/** The address a citation uses for a part, which keeps two parts of one source distinct. */
export function sourcePartAddress(sourceId: string, partKind: string, ordinal: number): string {
  return `part:${sourceId}:${partKind}:${ordinal}`;
}

/**
 * Writes a source's parts in one transaction. Re-running a batch refreshes the same rows.
 *
 * What a part already records wins over what a repeat supplies.
 *
 * A duplicate push writes no graph nodes, so it has no Turn ids at all; and a payload whose
 * turns carry no time of their own is prepared against the push's own clock, so a repeat
 * supplies a DIFFERENT fallback world time for the same turn. Both would overwrite the original
 * occurrence's proof with an artefact of when the duplicate happened to arrive. A receipt time
 * is not world time, and the first record of a part is the one every later reader resolves
 * against, so identity and clock proof are preserved together. Only the content hash refreshes,
 * because that is what a verifier compares the bytes against.
 */
export function recordSourceParts(
  db: SqliteHandle,
  sourceId: string,
  parts: readonly SourcePartInput[],
): void {
  const statement = db.prepare(
    `INSERT INTO source_parts
       (source_id, part_kind, ordinal, turn_id, role, content_hash, occurred_at, graph_clocks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, part_kind, ordinal) DO UPDATE SET
       turn_id = COALESCE(turn_id, excluded.turn_id),
       role = COALESCE(role, excluded.role),
       content_hash = excluded.content_hash,
       occurred_at = COALESCE(occurred_at, excluded.occurred_at),
       graph_clocks_json = COALESCE(graph_clocks_json, excluded.graph_clocks_json)`,
  );
  db.transaction((): void => {
    for (const part of parts) {
      statement.run(
        sourceId,
        part.partKind,
        part.ordinal,
        part.turnId ?? null,
        part.role ?? null,
        part.contentHash,
        part.occurredAt ?? null,
        part.graphClocksJson ?? null,
      );
    }
  }).immediate();
}

export type SourcePartRecord = {
  readonly sourceId: string;
  readonly partKind: string;
  readonly ordinal: number;
  readonly turnId: string | null;
  readonly role: string | null;
  readonly contentHash: string;
  readonly occurredAt: string | null;
};

type SourcePartRowData = {
  source_id: string;
  part_kind: string;
  ordinal: number;
  turn_id: string | null;
  role: string | null;
  content_hash: string;
  occurred_at: string | null;
};

const SELECT_SOURCE_PARTS = `SELECT source_id, part_kind, ordinal, turn_id, role, content_hash,
    occurred_at
  FROM source_parts`;

function toSourcePart(row: SourcePartRowData): SourcePartRecord {
  return {
    sourceId: row.source_id,
    partKind: row.part_kind,
    ordinal: row.ordinal,
    turnId: row.turn_id,
    role: row.role,
    contentHash: row.content_hash,
    occurredAt: row.occurred_at,
  };
}

/** One source's recorded parts, in the order a reconstruction has to preserve. */
export function readSourceParts(db: SqliteHandle, sourceId: string): readonly SourcePartRecord[] {
  const rows = db
    .prepare(`${SELECT_SOURCE_PARTS} WHERE source_id = ? ORDER BY part_kind, ordinal`)
    .all(sourceId) as SourcePartRowData[];
  return rows.map(toSourcePart);
}

/** One recorded part by its tuple, for a reader that verifies that part and no other. */
export function readSourcePart(
  db: SqliteHandle,
  sourceId: string,
  partKind: string,
  ordinal: number,
): SourcePartRecord | undefined {
  const row = db
    .prepare(`${SELECT_SOURCE_PARTS} WHERE source_id = ? AND part_kind = ? AND ordinal = ?`)
    .get(sourceId, partKind, ordinal) as SourcePartRowData | undefined;
  return row === undefined ? undefined : toSourcePart(row);
}

/** The part an original turn id addresses, for a caller holding a graph id rather than a tuple. */
export function findSourcePartByTurnId(
  db: SqliteHandle,
  turnId: string,
): SourcePartRecord | undefined {
  const row = db.prepare(`${SELECT_SOURCE_PARTS} WHERE turn_id = ?`).get(turnId) as
    SourcePartRowData | undefined;
  return row === undefined ? undefined : toSourcePart(row);
}

export type ReferenceBatch = {
  readonly sourceId: string;
  /** The canonical hash of the accepted set. A batch repeating the current set adds no version. */
  readonly acceptedHash: string;
  readonly receivedAt: Date;
  readonly operationKey: string;
  readonly introduced: readonly string[];
};

export type ReferenceBatchOutcome = {
  readonly referenceVersion: number;
  /** False when the batch repeated the accepted set or the operation that produced it. */
  readonly added: boolean;
};

/**
 * A delivery that allocated no version leaves no row to recognise it by, so its result is bound
 * to its operation key in the operations ledger instead. Without that binding the same delivery
 * retried after a later set had been accepted would compare against the newer hash, disagree,
 * and allocate a version for references it never introduced.
 */
type ReferenceDeliveryReceipt = {
  readonly referenceVersion: number;
  readonly acceptedHash: string;
};

function referenceDeliveryKey(sourceId: string, operationKey: string): string {
  return `reference-delivery:${encodeURIComponent(sourceId)}:${encodeURIComponent(operationKey)}`;
}

function readReferenceDeliveryReceipt(
  db: SqliteHandle,
  sourceId: string,
  operationKey: string,
): ReferenceDeliveryReceipt | undefined {
  const entry = getLedgerEntry(db, referenceDeliveryKey(sourceId, operationKey));
  return entry?.summary as ReferenceDeliveryReceipt | undefined;
}

/**
 * Accepts a reference batch as its own version, so the history of what arrived stops being a
 * merged union nobody can take apart. A batch that repeats the current accepted set is not a
 * new version, and a retried delivery under the same operation key returns the result it
 * produced the first time, whichever of those two it was.
 *
 * The same operation key carrying a different accepted set is refused: one delivery has one
 * outcome, and letting a key stand for two of them would make the recorded result unreadable.
 */
export function acceptReferenceBatch(
  db: SqliteHandle,
  batch: ReferenceBatch,
): ReferenceBatchOutcome {
  return db
    .transaction((): ReferenceBatchOutcome => {
      const byOperation = db
        .prepare(
          `SELECT reference_version, accepted_hash FROM source_reference_batches
           WHERE source_id = ? AND operation_key = ?`,
        )
        .get(batch.sourceId, batch.operationKey) as
        { reference_version: number; accepted_hash: string } | undefined;
      if (byOperation !== undefined) {
        if (byOperation.accepted_hash !== batch.acceptedHash) {
          throw new Error(
            `operation ${batch.operationKey} on source ${batch.sourceId} already accepted a different set`,
          );
        }
        return { referenceVersion: byOperation.reference_version, added: false };
      }

      const receipt = readReferenceDeliveryReceipt(db, batch.sourceId, batch.operationKey);
      if (receipt !== undefined) {
        if (receipt.acceptedHash !== batch.acceptedHash) {
          throw new Error(
            `operation ${batch.operationKey} on source ${batch.sourceId} already accepted a different set`,
          );
        }
        return { referenceVersion: receipt.referenceVersion, added: false };
      }

      const latest = db
        .prepare(
          `SELECT reference_version, accepted_hash FROM source_reference_batches
           WHERE source_id = ? ORDER BY reference_version DESC LIMIT 1`,
        )
        .get(batch.sourceId) as { reference_version: number; accepted_hash: string } | undefined;
      if (latest?.accepted_hash === batch.acceptedHash) {
        markLedgerApplied(db, referenceDeliveryKey(batch.sourceId, batch.operationKey), {
          referenceVersion: latest.reference_version,
          acceptedHash: batch.acceptedHash,
        } satisfies ReferenceDeliveryReceipt);
        return { referenceVersion: latest.reference_version, added: false };
      }

      const referenceVersion = (latest?.reference_version ?? 0) + 1;
      db.prepare(
        `INSERT INTO source_reference_batches
           (source_id, reference_version, accepted_hash, received_at, operation_key, introduced_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        batch.sourceId,
        referenceVersion,
        batch.acceptedHash,
        batch.receivedAt.toISOString(),
        batch.operationKey,
        JSON.stringify([...batch.introduced]),
      );
      return { referenceVersion, added: true };
    })
    .immediate();
}

/** The accepted reference versions for a source, oldest first. */
export function listReferenceBatches(
  db: SqliteHandle,
  sourceId: string,
): readonly { referenceVersion: number; acceptedHash: string; receivedAt: string }[] {
  const rows = db
    .prepare(
      `SELECT reference_version, accepted_hash, received_at FROM source_reference_batches
       WHERE source_id = ? ORDER BY reference_version`,
    )
    .all(sourceId) as {
    reference_version: number;
    accepted_hash: string;
    received_at: string;
  }[];
  return rows.map((row) => ({
    referenceVersion: row.reference_version,
    acceptedHash: row.accepted_hash,
    receivedAt: row.received_at,
  }));
}

/**
 * The graph turn ids a source's parts record, in ordinal order. A rebuild or a replay projects
 * under these rather than minting fresh ones: the whole point of recording them is that the same
 * turn comes back as the same node.
 */
export function readSourcePartTurnIds(db: SqliteHandle, sourceId: string): readonly string[] {
  const rows = db
    .prepare(
      `SELECT turn_id FROM source_parts
       WHERE source_id = ? AND part_kind = 'turn' AND turn_id IS NOT NULL
       ORDER BY ordinal`,
    )
    .all(sourceId) as { turn_id: string }[];
  return rows.map((row) => row.turn_id);
}

/**
 * What one delivery produced, for a reader that must not re-run the acceptance to learn it.
 *
 * A delivery that allocated no version leaves no row to recognise it by, so its outcome lives in
 * the operations ledger instead. Reading only the batch table would call such a delivery
 * unaccepted, and a caller treating that as a failure wedges the pending slot for every other
 * publication. Both places are consulted here, and neither allocates anything.
 */
export function readReferenceDelivery(
  db: SqliteHandle,
  sourceId: string,
  operationKey: string,
): ReferenceDeliveryReceipt | undefined {
  const row = db
    .prepare(
      `SELECT reference_version, accepted_hash FROM source_reference_batches
       WHERE source_id = ? AND operation_key = ?`,
    )
    .get(sourceId, operationKey) as
    { reference_version: number; accepted_hash: string } | undefined;
  if (row !== undefined) {
    return { referenceVersion: row.reference_version, acceptedHash: row.accepted_hash };
  }
  return readReferenceDeliveryReceipt(db, sourceId, operationKey);
}

/** Preserved projection clocks are evidence distinct from the current projection's creation time. */
export function readSourceGraphClocksJson(db: SqliteHandle, sourceId: string): string | undefined {
  const row = db
    .prepare('SELECT graph_clocks_json FROM source_records WHERE source_id = ?')
    .get(sourceId) as { graph_clocks_json: string | null } | undefined;
  return row?.graph_clocks_json ?? undefined;
}

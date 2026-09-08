import type { ReflectionOrigin, ReflectionProvenance } from '@aion/protocol';

import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  experienceArchiveKey,
  getExperienceByKey,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { recordIngest } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  allocateProcessingGeneration,
  listGenerations,
  prepareInventorySkeleton,
  activateProcessingGeneration,
  prepareGenerationWork,
} from '../../infrastructure/sqlite/processing-generations.js';
import {
  acceptReferenceBatch,
  recordSourceParts,
  recordSourceRecord,
  type SourcePartInput,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  captureOrderValue,
  recordEvidenceAcknowledgment,
  SEMANTIC_PROCESSING_EFFECT,
  SOURCE_INDEX_EFFECT,
  touchSessionRemainder,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { hashContent, type PreparedEpisode, type ReflectionContent } from '../domain/content.js';

/**
 * The durable records an accepted payload leaves behind, written as one synchronous
 * transaction beside the archive row.
 *
 * They exist so identity survives the raw projection. The archive says what the substrate was
 * told; these say which source that was, which parts it holds, what references arrived with it,
 * and what processing it owes. A caller retrying from here resumes these exact rows rather than
 * minting a second set.
 *
 * Nothing here is claimable yet. The generation is allocated and its stage rows are written
 * while it is still inactive, so no worker can take work on a source whose projection does not
 * exist. Activation is the acknowledgment step, and it is what makes the inventory live.
 */
export type ReadinessInventory = {
  readonly policyRevision: number;
  /** Every stage the policy requires. A stage with no row would measure as no work at all. */
  readonly stageNames: readonly string[];
};

export type SourceManifestInput = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly identity: string;
  readonly prepared: PreparedEpisode;
  /** The redacted content, which is what the archive holds and a re-derivation must match. */
  readonly payload: ReflectionContent;
  readonly references: ReflectionProvenance | undefined;
  readonly lane: string | undefined;
  readonly origin: ReflectionOrigin | undefined;
  readonly pipelineVersion: string;
  readonly operationKey: string;
  readonly readiness: ReadinessInventory | undefined;
  readonly now: Date;
};

export type SourceManifest = {
  readonly sourceId: string;
  /** False when the archive already held this experience under this identity. */
  readonly archived: boolean;
  readonly identityHash: string;
  readonly processingGeneration: number;
  readonly referenceVersion: number;
  readonly ingestPosition: number;
};

/** The obligation a source touched before its readiness policy exists still owes an inventory. */
const PENDING_INVENTORY_WORK = 'inventory:pending_policy';

function partHash(value: unknown): string {
  return hashContent(value);
}

/**
 * One row per part of the source: its turns, its observations, its tool executions. Only turns
 * carry an original turn id, and nothing invents one for the others.
 */
export function sourcePartsOf(
  prepared: PreparedEpisode,
  payload: ReflectionContent,
  turnIds: readonly string[],
): readonly SourcePartInput[] {
  const turns = prepared.turns.map((turn, index) => ({
    partKind: 'turn' as const,
    ordinal: index,
    ...(turnIds[index] === undefined ? {} : { turnId: turnIds[index] }),
    role: turn.role,
    contentHash: turn.contentHash,
    occurredAt: turn.occurredAt.toISOString(),
  }));
  const observations = (payload.observations ?? []).map((entry, index) => ({
    partKind: 'observation' as const,
    ordinal: index,
    contentHash: partHash(entry),
  }));
  const executions = (payload.tool_executions ?? []).map((entry, index) => ({
    partKind: 'tool_execution' as const,
    ordinal: index,
    contentHash: partHash(entry),
    ...(entry.occurred_at === undefined ? {} : { occurredAt: entry.occurred_at }),
  }));
  return [...turns, ...observations, ...executions];
}

/** The canonical hash of an accepted reference set, so a batch repeating it adds no version. */
export function referenceSetHash(references: ReflectionProvenance | undefined): string {
  return hashContent(references ?? {});
}

function introducedReferences(references: ReflectionProvenance | undefined): readonly string[] {
  return [
    ...(references?.supersedes ?? []),
    ...(references?.derived_from ?? []),
    ...(references?.confirmations ?? []).map((entry) => entry.target),
  ];
}

/**
 * The archive row and every identity record of one acceptance, in the caller's transaction.
 *
 * It refuses outside one: the records are only worth having together, and a partial write would
 * leave a source whose parts or reference history nobody can account for. The caller owns the
 * transaction because the durable prepare of a publication is a single short commit that also
 * carries the intent.
 */
export function writeSourceManifest(
  db: SqliteHandle,
  input: SourceManifestInput,
  turnIds: readonly string[],
): SourceManifest {
  if (!db.inTransaction) {
    throw new Error('the source manifest is written inside the acceptance transaction');
  }
  const identityHash = experienceArchiveKey(
    input.identity,
    input.prepared.contentHash,
    ARCHIVE_SCHEMA_VERSION,
  );
  const archived = insertExperience(db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: input.pipelineVersion,
    identity: input.identity,
    sessionId: input.sessionId,
    episodeId: input.sourceId,
    contentHash: input.prepared.contentHash,
    occurredAt: input.prepared.occurredAt.toISOString(),
    archivedAt: input.now.toISOString(),
    ...(input.lane === undefined ? {} : { lane: input.lane }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    payload: input.payload,
  });
  const ingestPosition = recordIngest(db, input.sourceId, input.now);
  // The archive row the source is verified against, read back rather than assumed: its id is
  // the row's own, and a re-push resolves to the row the first acceptance wrote.
  const row = getExperienceByKey(
    db,
    input.identity,
    input.prepared.contentHash,
    ARCHIVE_SCHEMA_VERSION,
  );
  if (row === undefined) {
    throw new Error(`source ${input.sourceId} has no archive row to verify against`);
  }
  recordSourceRecord(db, {
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    verificationStatus: 'verified',
    occurredAt: input.prepared.occurredAt.toISOString(),
    createdAt: input.now,
    archive: {
      canonicalArchiveId: row.id,
      archiveSchemaVersion: row.schemaVersion,
      identityHash,
      verifiedContentDigest: row.contentHash,
      verificationPolicyVersion: ARCHIVE_SCHEMA_VERSION,
      archivedAt: row.archivedAt,
    },
    captureOrderValue: captureOrderValue(ingestPosition),
    captureOrderBasis: 'archive_acceptance',
    ...(input.origin === undefined ? {} : { origin: input.origin.channel }),
  });
  recordSourceParts(db, input.sourceId, sourcePartsOf(input.prepared, input.payload, turnIds));
  const batch = acceptReferenceBatch(db, {
    sourceId: input.sourceId,
    acceptedHash: referenceSetHash(input.references),
    receivedAt: input.now,
    operationKey: input.operationKey,
    introduced: introducedReferences(input.references),
  });
  const processingGeneration = generationFor(db, input);
  writeInventorySkeleton(db, input, processingGeneration);
  recordEvidenceAcknowledgment(db, {
    sourceId: input.sourceId,
    referenceVersion: batch.referenceVersion,
    effectKind: SEMANTIC_PROCESSING_EFFECT,
    state: 'owed',
  });
  recordEvidenceAcknowledgment(db, {
    sourceId: input.sourceId,
    referenceVersion: batch.referenceVersion,
    effectKind: SOURCE_INDEX_EFFECT,
    state: 'owed',
  });
  return {
    sourceId: input.sourceId,
    archived,
    identityHash,
    processingGeneration,
    referenceVersion: batch.referenceVersion,
    ingestPosition,
  };
}

/**
 * The generation this acceptance processes under. A retry resumes the one it already allocated
 * rather than spending a second number, which is what makes the durable prepare replayable; a
 * forgotten re-push is a different source and starts at one of its own.
 */
function generationFor(db: SqliteHandle, input: SourceManifestInput): number {
  const held = listGenerations(db, input.sourceId).find(
    (generation) =>
      generation.state !== 'replaced' && generation.inputDigest === input.prepared.contentHash,
  );
  return (
    held?.processingGeneration ??
    allocateProcessingGeneration(db, {
      sourceId: input.sourceId,
      policyRevision: input.readiness?.policyRevision ?? 0,
      inputDigest: input.prepared.contentHash,
      createdAt: input.now,
    })
  );
}

/**
 * Every stage the policy requires, or, when no policy has been published yet, one row saying so.
 *
 * The obligation row is the honest answer to a source accepted before the readiness census: a
 * generation with no rows at all measures as a generation that owes nothing, and reporting a
 * missing inventory as zero is exactly how an unprocessed source passes for a finished one.
 */
function writeInventorySkeleton(
  db: SqliteHandle,
  input: SourceManifestInput,
  processingGeneration: number,
): void {
  if (input.readiness === undefined) {
    prepareGenerationWork(db, {
      workId: `${PENDING_INVENTORY_WORK}:${input.sourceId}:${String(processingGeneration)}`,
      sourceId: input.sourceId,
      processingGeneration,
      kind: 'inventory',
      workKey: PENDING_INVENTORY_WORK,
      dueAt: input.now,
    });
    return;
  }
  prepareInventorySkeleton(db, {
    sourceId: input.sourceId,
    processingGeneration,
    stageNames: input.readiness.stageNames,
    dueAt: input.now,
  });
}

export type ManifestAcknowledgment = {
  readonly sourceId: string;
  readonly processingGeneration: number;
  readonly sessionId: string;
  readonly captureOrderValue: string;
  readonly now: Date;
};

/**
 * The acknowledgment half: the inventory becomes live and the session's remainder moves.
 *
 * Activation happens here and not at prepare, so nothing can claim work on a source whose graph
 * projection was never committed. The remainder watermark moves with it because the source has
 * joined the session's unsealed tail at this moment and not before.
 *
 * Returns the readiness revision the activation published.
 */
export function activateSourceManifest(db: SqliteHandle, input: ManifestAcknowledgment): number {
  if (!db.inTransaction) {
    throw new Error('the manifest is activated inside the acknowledgment transaction');
  }
  const published = activateProcessingGeneration(db, input.sourceId, input.processingGeneration);
  touchSessionRemainder(db, input.sessionId, input.captureOrderValue, input.now);
  return published;
}

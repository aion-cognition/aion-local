import { z } from 'zod';

import { sourcePartsOf } from './source-manifest.js';
import type { LegacyRawNodes } from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  getExperienceById,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  groupArchiveRowsBySource,
  pageArchiveRowsForEpisode,
  verifiedSourceRecordInput,
  type ArchiveSourceGroup,
} from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  readSourceRecord,
  recordSourceParts,
  recordSourceRecord,
  type SourcePartInput,
  type SourceRecordInput,
} from '../../infrastructure/sqlite/source-identity.js';
import { prepareEpisode } from '../domain/content.js';

const ArchiveProof = z.strictObject({
  canonicalArchiveId: z.string().min(1),
  archiveSchemaVersion: z.number().int(),
  identityHash: z.string().min(1),
  verifiedContentDigest: z.string().min(1),
  verificationPolicyVersion: z.number().int(),
  archivedAt: z.string().min(1),
  aliasArchiveIds: z.array(z.string().min(1)).optional(),
});
const SourceRecordPlanned = z.strictObject({
  sourceId: z.string().min(1),
  sessionId: z.string().min(1),
  verificationStatus: z.enum(['verified', 'unresolved', 'pinned']),
  verificationReason: z.string().optional(),
  occurredAt: z.string().min(1),
  createdAt: z.string().min(1),
  archive: ArchiveProof.optional(),
  graphClocksJson: z.string().optional(),
  captureOrderValue: z.string().optional(),
  captureOrderBasis: z.enum(['graph_tx_from', 'archive_acceptance', 'pinned']).optional(),
  origin: z.string().optional(),
});
const PartPlanned = z.strictObject({
  partKind: z.enum(['turn', 'observation', 'tool_execution']),
  ordinal: z.number().int().nonnegative(),
  turnId: z.string().optional(),
  role: z.string().optional(),
  contentHash: z.string().min(1),
  occurredAt: z.string().optional(),
  graphClocksJson: z.string().optional(),
});
/**
 * The plan as the intent stores it. A replayed acknowledgment writes what was decided under
 * the guard, not what a second reading of the stores would decide now.
 */
export const VerificationSchema = z.strictObject({
  sourceId: z.string().min(1),
  status: z.enum(['verified', 'pinned']),
  reason: z.string(),
  record: SourceRecordPlanned.optional(),
  parts: z.array(PartPlanned).optional(),
});
/**
 * Whether a source's raw projection is still what its records say it is.
 *
 * This is the decision the strict rebuild rests on: only a VERIFIED source may be projected
 * again, and verified means the archived bytes and the graph agree today, not that somebody
 * once said so. The decision is taken here, as a plan, and applied by the publication that
 * holds the guard — a verdict written outside one is a verdict nobody can prove was taken
 * against the substrate it describes.
 *
 * A disagreement pins. Nothing here picks a side, invents an archive row, or improves a proof
 * it cannot make.
 */
export type SourceRecordPlan = Omit<SourceRecordInput, 'createdAt'> & {
  /** ISO, because the plan is stored in the publication's intent and replayed from it. */
  readonly createdAt: string;
};

export type VerificationPlan = {
  readonly sourceId: string;
  readonly status: 'verified' | 'pinned';
  readonly reason: string;
  /** The record the acknowledgment writes, or nothing when the held record already stands. */
  readonly record?: SourceRecordPlan;
  readonly parts?: readonly SourcePartInput[];
};

export type VerificationInput = {
  readonly sourceId: string;
  readonly bounds: { readonly low: number; readonly high: number };
  readonly raw: LegacyRawNodes | undefined;
  readonly now: Date;
  /**
   * Prove a source that already reads verified, rather than leaving its record alone.
   *
   * The ordinary walk leaves it alone: a live acceptance wrote that record under proof the walk
   * cannot improve on. A re-verification is the opposite question — is it STILL true — and the
   * strict rebuild rests on the answer, so it re-reads both stores whatever the record says. The
   * bounds it is given must cover the whole archive, or a source archived outside them pins for
   * being outside a window rather than for having drifted.
   */
  readonly reverify?: boolean;
};

function pinned(
  input: VerificationInput,
  group: ArchiveSourceGroup | undefined,
  held: {
    readonly sessionId?: string;
    readonly occurredAt?: string;
  },
  reason: string,
): VerificationPlan {
  return {
    sourceId: input.sourceId,
    status: 'pinned',
    reason,
    record: {
      sourceId: input.sourceId,
      sessionId: group?.sessionId ?? input.raw?.sessionId ?? held.sessionId ?? input.sourceId,
      verificationStatus: 'pinned',
      verificationReason: reason,
      occurredAt: group?.occurredAt ?? held.occurredAt ?? input.now.toISOString(),
      createdAt: input.now.toISOString(),
      ...(group === undefined
        ? { captureOrderBasis: 'pinned' as const }
        : {
            captureOrderValue: group.archivedAt,
            captureOrderBasis: 'archive_acceptance' as const,
          }),
    },
  };
}

/**
 * What the archive and the graph together say about one source.
 *
 * A source the live intake already verified is left alone: its record was written by the writer
 * that accepted it, under proof this pass cannot improve on, and rewriting it from the archive
 * would replace an acceptance clock with a migration's own.
 */
export function planSourceVerification(
  db: SqliteHandle,
  input: VerificationInput,
): VerificationPlan {
  const held = readSourceRecord(db, input.sourceId);
  const heldFields = {
    ...(held === undefined ? {} : { sessionId: held.sessionId, occurredAt: held.occurredAt }),
  };
  if (held?.verificationStatus === 'verified' && input.reverify !== true) {
    return {
      sourceId: input.sourceId,
      status: 'verified',
      reason: 'the live acceptance already proved this source',
    };
  }
  const group = groupArchiveRowsBySource(
    pageArchiveRowsForEpisode(db, input.sourceId, input.bounds),
  ).find((entry) => entry.sourceId === input.sourceId);
  if (group === undefined) {
    return pinned(
      input,
      group,
      heldFields,
      'the archive holds no row for this source inside the frozen bounds',
    );
  }
  if (group.conflictingAliases) {
    return pinned(
      input,
      group,
      heldFields,
      'archive rows for this episode disagree about its content',
    );
  }
  const { raw } = input;
  if (raw === undefined) {
    return pinned(input, group, heldFields, 'the graph holds no projection of this source');
  }
  if (raw.contentHash === undefined || raw.contentHash !== group.contentHash) {
    return pinned(
      input,
      group,
      heldFields,
      'the archived digest disagrees with the graph projection',
    );
  }
  const experience = getExperienceById(db, group.canonicalArchiveId);
  if (experience === undefined) {
    return pinned(input, group, heldFields, 'the canonical archive row could not be read back');
  }
  // The parts come from the payload, because that is where they all are. Only turns have a graph
  // node; an observation and a tool execution have a logical address and nothing else, and a pass
  // that recorded only what the graph shows would leave those parts uncitable forever.
  const prepared = prepareEpisode(experience.payload, new Date(group.occurredAt));
  const mismatch = prepared.turns.findIndex(
    (turn, index) => raw.turns[index]?.contentHash !== turn.contentHash,
  );
  if (mismatch >= 0) {
    return pinned(
      input,
      group,
      heldFields,
      `graph turn ${String(mismatch)} does not carry the archived turn's digest`,
    );
  }
  return {
    sourceId: input.sourceId,
    status: 'verified',
    reason: 'the archived digest matches the graph projection',
    record: {
      ...verifiedSourceRecordInput(group, {
        verificationPolicyVersion: ARCHIVE_SCHEMA_VERSION,
        createdAt: input.now,
      }),
      createdAt: input.now.toISOString(),
    },
    parts: sourcePartsOf(
      prepared,
      experience.payload,
      raw.turns.map((turn) => turn.turnId),
    ),
  };
}

/** Applies a plan. Only ever called from inside a publication's acknowledgment transaction. */
export function applySourceVerification(db: SqliteHandle, plan: VerificationPlan): void {
  if (plan.record === undefined) {
    return;
  }
  recordSourceRecord(db, { ...plan.record, createdAt: new Date(plan.record.createdAt) });
  if (plan.parts !== undefined) {
    recordSourceParts(db, plan.sourceId, plan.parts);
  }
}

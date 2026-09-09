import { z } from 'zod';

import { sourcePartsOf } from './source-manifest.js';
import type { LegacyRawNodes } from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  getExperienceById,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  archiveGroupFor,
  verifiedSourceRecordInput,
  type ArchiveSourceGroup,
} from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  readSourceParts,
  readSourceRecord,
  recordSourceParts,
  recordSourceRecord,
  type SourcePartInput,
  type SourceRecordInput,
} from '../../infrastructure/sqlite/source-identity.js';
import { recordSourceStateVersion } from '../../infrastructure/sqlite/source-lifecycle.js';
import { committedSourceStates } from '../../infrastructure/sqlite/source-states.js';
import { prepareEpisode, type PreparedEpisode, type ReflectionContent } from '../domain/content.js';

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
  forgottenAt: z.string().min(1).optional(),
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
  /**
   * When the graph recorded this source as forgotten. A suppression is a statement about the
   * source that outlives its content: migrating the bytes and leaving it behind is a forgotten
   * memory answering again, so the acknowledgment writes it as the durable state it should
   * always have been.
   */
  readonly forgottenAt?: string;
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
  // Resolved through the canonical mapping the record already carries, so a later occurrence of
  // the same bytes is proved against the row both occurrences were verified against.
  const group = archiveGroupFor(db, input.sourceId, held?.canonicalArchiveId ?? null, input.bounds);
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
  // Hashed with the statements stripped, the way the acceptance hashed it. A legacy row's
  // provenance was merged into the stored payload after its digest was taken, so recomputing
  // over the whole row would pin every source that ever carried a reference.
  const prepared = prepareEpisode(
    withoutStatements(experience.payload),
    new Date(group.occurredAt),
  );
  const gap = rawProofGap(db, input.sourceId, group, raw, prepared);
  if (gap !== undefined) {
    return pinned(input, group, heldFields, gap);
  }
  return {
    sourceId: input.sourceId,
    status: 'verified',
    reason: 'the archived digest matches the graph projection',
    ...(raw.forgottenAt === undefined ? {} : { forgottenAt: raw.forgottenAt }),
    record: {
      ...verifiedSourceRecordInput(group, {
        verificationPolicyVersion: ARCHIVE_SCHEMA_VERSION,
        createdAt: input.now,
      }),
      createdAt: input.now.toISOString(),
    },
    parts: sourcePartsOf(
      prepared,
      withoutStatements(experience.payload),
      raw.turns.map((turn) => turn.turnId),
    ),
  };
}

/**
 * The content as it was hashed: without the statements a later merge folded into the row.
 *
 * Identity is the experience, and a caller's assertions about other memories are not part of it.
 * Intake hashes the content before the statements are recorded, and the archive row keeps that
 * digest, so a proof that hashed the row as it stands now would disagree with every row anybody
 * ever stated a reference on.
 */
function withoutStatements(content: ReflectionContent): ReflectionContent {
  if (!('provenance' in content)) {
    return content;
  }
  const { provenance, ...rest } = content;
  void provenance;
  return rest;
}

/**
 * What the bounded raw identity does not prove, or nothing when all of it holds.
 *
 * Every check here is one a comparison of stored digests cannot make. A digest column is a value
 * somebody wrote; the proof is the payload recomputed, the parts counted, the roles and the
 * sequence compared, and the original ids the records already hold left where they are.
 */
function rawProofGap(
  db: SqliteHandle,
  sourceId: string,
  group: ArchiveSourceGroup,
  raw: LegacyRawNodes,
  prepared: PreparedEpisode,
): string | undefined {
  // Recomputed, never read off the column: an archive row edited in place keeps its old digest.
  if (prepared.contentHash !== group.contentHash) {
    return 'the archived payload does not hash to the digest its row records';
  }
  if (raw.contentHash !== group.contentHash) {
    return 'the archived digest disagrees with the graph projection';
  }
  if (raw.sessionId !== group.sessionId) {
    return `the graph places this source in session ${raw.sessionId ?? 'none'}, the archive in ${group.sessionId}`;
  }
  if (raw.turns.length !== prepared.turns.length) {
    return `the graph holds ${String(raw.turns.length)} turns where the archive holds ${String(prepared.turns.length)}`;
  }
  const recorded = new Map(
    readSourceParts(db, sourceId)
      .filter((part) => part.partKind === 'turn' && part.turnId !== null)
      .map((part) => [part.ordinal, part.turnId]),
  );
  // Keyed on the sequence each turn recorded, never on where it appeared in the returned array.
  // Matching by position would compare the reader's own ordering against itself and call a turn
  // whose recorded place disagrees with the archive proved.
  const projection = new Map(raw.turns.map((turn) => [turn.ordinal, turn]));
  for (const [ordinal, turn] of prepared.turns.entries()) {
    const projected = projection.get(ordinal);
    if (projected === undefined) {
      return `the graph records no turn at ordinal ${String(ordinal)}`;
    }
    if (projected.contentHash !== turn.contentHash) {
      return `graph turn ${String(ordinal)} does not carry the archived turn's digest`;
    }
    // The bytes, not the digest column. A projection edited in place keeps the hash it was
    // written with, so the only thing that proves the text is the text — and a projection holding
    // no text at all has not proved it either. Absent required proof is missing proof, not proof
    // that happens to be unavailable: skipping the comparison where the bytes are gone verifies
    // exactly the source whose bytes nobody can check.
    if (projected.text === undefined) {
      return `graph turn ${String(ordinal)} carries no text to prove the archived turn against`;
    }
    if (projected.text !== turn.text) {
      return `graph turn ${String(ordinal)} does not carry the archived turn's text`;
    }
    if (projected.role !== turn.role) {
      return `graph turn ${String(ordinal)} is recorded as ${projected.role ?? 'no role'} where the archive says ${turn.role}`;
    }
    // The original id is the one every later reader resolves against. A projection under a
    // different name is a different node, however faithful its text.
    const held = recorded.get(ordinal);
    if (held !== undefined && held !== projected.turnId) {
      return `graph turn ${String(ordinal)} is ${projected.turnId}, where the records hold ${held}`;
    }
  }
  return undefined;
}

/**
 * The FORGET family: the closing statement and its reversal, and nothing else.
 *
 * Suppression is a separate chain with a separate reversal, and reading the two together is the
 * conflation the whole cut exists to prevent. An unsuppress is not an unforget: treating one as
 * history of the other lets an unrelated modern suppression decide whether a legacy forget may be
 * imported at all, which answers a question about one instruction with another instruction.
 */
const FORGET_STATES: readonly string[] = ['forgotten', 'unforgotten'];

/**
 * Whether anybody has already stated something about this source being forgotten.
 *
 * Not "is it forgotten now": a chain that says forgotten and then unforgotten is a chain, and a
 * baseline may only be imported where that family has none.
 */
function hasCommittedForgetHistory(db: SqliteHandle, sourceId: string): boolean {
  return committedSourceStates(db, sourceId).some((state) =>
    FORGET_STATES.includes(state.stateKind),
  );
}

/** Applies a plan. Only ever called from inside a publication's acknowledgment transaction. */
export function applySourceVerification(
  db: SqliteHandle,
  plan: VerificationPlan,
  /**
   * The publication whose acknowledgment this write belongs to. A statement about a source joins
   * the committed view through its operation, so a caller outside one records the records and not
   * the statement: there is no operation for it to be committed under.
   */
  binding?: { readonly operationId: string; readonly knownFrom: Date },
): void {
  // The suppression travels first and whatever else does: a source whose content could not be
  // proved is still a source somebody forgot, and its statement is not the content's to lose.
  //
  // It travels ONLY into an uncovered FORGET chain. A source that already carries committed forget
  // statements has a history somebody wrote deliberately, and appending an imported observation to
  // it makes that old observation the newest operative instruction — which is how a modern
  // unforget gets undone by a migration reading a stamp the graph never cleared. Where the two
  // disagree the durable chain wins and the disagreement stays visible on the record. What the
  // other family says is not consulted: it answers a different question about a different chain.
  if (
    binding !== undefined &&
    plan.forgottenAt !== undefined &&
    !hasCommittedForgetHistory(db, plan.sourceId)
  ) {
    recordSourceStateVersion(db, {
      sourceId: plan.sourceId,
      stateKind: 'forgotten',
      operationId: binding.operationId,
      observedAt: new Date(plan.forgottenAt),
      knownFrom: binding.knownFrom,
      detail: { basis: 'legacy_graph_suppression', forgotten_at: plan.forgottenAt },
    });
  }
  if (plan.record === undefined) {
    return;
  }
  recordSourceRecord(db, { ...plan.record, createdAt: new Date(plan.record.createdAt) });
  if (plan.parts !== undefined) {
    recordSourceParts(db, plan.sourceId, plan.parts);
  }
}

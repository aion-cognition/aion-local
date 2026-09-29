import { archiveProofHolds, gateSource, issueOn, type SourceGateRequest } from './source-gate.js';
import { renderPartValue, verifyParts } from './source-parts.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  experiencePayloadBytes,
  getExperienceById,
  type ExperienceArchiveRow,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  readSourceParts,
  type SourcePartRecord,
  type SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { hashContent, renderEpisodeText } from '../../reflection/domain/content.js';
import { partAddress, type EvidenceAddress, type SourcePartKind } from '../domain/address.js';
import { utf16CodeUnits, utf8Bytes, type RequestBudget } from '../domain/budget.js';
import type { EvidenceIssue, EvidenceResidency } from '../domain/result.js';

/**
 * Raw source evidence, rebuilt from the archived payload and the recorded part mapping.
 *
 * The archive holds the bytes and the identity records say which source they are, which part is
 * which, and what has been stated about the source since. Both halves are checked before a
 * caller sees any of it: an archive row that does not hash to what the record says it verified
 * is an unresolved mapping, not a source. Residency never enters that decision, so an evicted
 * source answers exactly as completely as a resident one.
 */

export type SourcePartEvidence = {
  readonly address: EvidenceAddress;
  readonly partKind: SourcePartKind;
  readonly ordinal: number;
  readonly role?: string;
  /** The original graph id, on the parts that had one. Nothing invents one for the others. */
  readonly turnId?: string;
  readonly text: string;
  readonly occurredAt?: string;
  readonly decodedRawUtf8Bytes: number;
  readonly rawUtf16CodeUnits: number;
};

export type SourceEvidence = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  /** What was addressed: the whole source, or the one part a tuple named. */
  readonly text: string;
  /**
   * The whole source as it was captured, which is the addressed part's own context. A request
   * lands in one turn and its result in another, so a part read that carried only its own bytes
   * would hand a caller half of an exchange.
   */
  readonly sourceText: string;
  readonly parts: readonly SourcePartEvidence[];
  readonly decodedRawUtf8Bytes: number;
  readonly rawUtf16CodeUnits: number;
};

export type SourceResolution = {
  readonly residency: EvidenceResidency;
  readonly issues: readonly EvidenceIssue[];
  readonly dependencies: readonly EvidenceDependency[];
  readonly value?: SourceEvidence;
};

export type SourceReadRequest = SourceGateRequest & { readonly budget: RequestBudget };

/**
 * The digest the acceptance recorded. Stated references ride in the archived payload without
 * ever reaching the hash, so the same experience pushed with and without them stays one source
 * and a reference folded in later does not read as tampering.
 */
function archivedContentDigest(row: ExperienceArchiveRow): string {
  const { provenance, ...content } = row.payload;
  return hashContent(provenance === undefined ? row.payload : content);
}

type PayloadRead =
  | { readonly status: 'read'; readonly row: ExperienceArchiveRow }
  | { readonly status: 'failed'; readonly issue: EvidenceIssue };

/**
 * The archived bytes, charged against the request's allowance before anything decodes them.
 * A payload the budget cannot carry is named at its address rather than dropped from the answer.
 */
function readPayload(
  db: SqliteHandle,
  record: SourceRecord,
  address: EvidenceAddress,
  request: SourceReadRequest,
): PayloadRead {
  const archiveId = record.canonicalArchiveId;
  if (archiveId === null || record.verificationStatus !== 'verified') {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'unresolved_mapping', request.required),
    };
  }
  const bytes = experiencePayloadBytes(db, archiveId);
  if (bytes === undefined) {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'unresolved_mapping', request.required),
    };
  }
  if (request.budget.chargeRawBytes(bytes) !== undefined) {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'budget_limit', request.required),
    };
  }
  const row = getExperienceById(db, archiveId);
  if (row === undefined) {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'unresolved_mapping', request.required),
    };
  }
  if (!archiveProofHolds(record, row) || archivedContentDigest(row) !== row.contentHash) {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'unresolved_mapping', request.required),
    };
  }
  return { status: 'read', row };
}

function partText(row: ExperienceArchiveRow, part: SourcePartRecord): string | undefined {
  const { payload } = row;
  const kind = part.partKind as SourcePartKind;
  const values = {
    turn: payload.turns,
    observation: payload.observations,
    tool_execution: payload.tool_executions,
  }[kind];
  const value = (values ?? [])[part.ordinal];
  return value === undefined ? undefined : renderPartValue(kind, value);
}

function partEvidence(row: ExperienceArchiveRow, part: SourcePartRecord): SourcePartEvidence {
  const text = partText(row, part) ?? '';
  return {
    address: partAddress(part.sourceId, part.partKind as SourcePartKind, part.ordinal),
    partKind: part.partKind as SourcePartKind,
    ordinal: part.ordinal,
    ...(part.role === null ? {} : { role: part.role }),
    ...(part.turnId === null ? {} : { turnId: part.turnId }),
    text,
    ...(part.occurredAt === null ? {} : { occurredAt: part.occurredAt }),
    decodedRawUtf8Bytes: utf8Bytes(text),
    rawUtf16CodeUnits: utf16CodeUnits(text),
  };
}

function evidenceOf(
  row: ExperienceArchiveRow,
  record: SourceRecord,
  parts: readonly SourcePartEvidence[],
  whole: boolean,
): SourceEvidence {
  const sourceText = renderEpisodeText(row.payload);
  const text = whole ? sourceText : parts.map((part) => part.text).join('\n');
  return {
    sourceId: record.sourceId,
    sessionId: record.sessionId,
    occurredAt: record.occurredAt,
    text,
    sourceText,
    parts,
    decodedRawUtf8Bytes: utf8Bytes(text),
    rawUtf16CodeUnits: utf16CodeUnits(text),
  };
}

/** One address, resolved to verified raw evidence or to the reason it is not there. */
export function resolveSourceEvidence(
  db: SqliteHandle,
  address: EvidenceAddress,
  request: SourceReadRequest,
): SourceResolution {
  const gate = gateSource(db, address, request);
  if (gate.status === 'closed') {
    return { residency: gate.residency, issues: gate.issues, dependencies: gate.dependencies };
  }
  const { located, record, residency, dependencies } = gate;

  const stored = readSourceParts(db, located.sourceId);
  const payload = readPayload(db, record, address, request);
  if (payload.status === 'failed') {
    return { residency, issues: [payload.issue], dependencies };
  }

  const issues = [...verifyParts(payload.row, record, stored, request)];

  const selected =
    located.kind === 'source'
      ? stored
      : stored.filter(
          (part) => part.partKind === located.partKind && part.ordinal === located.ordinal,
        );
  if (selected.length === 0) {
    return {
      residency,
      issues: [...issues, issueOn(address, 'source_content', 'not_found', request.required)],
      dependencies,
    };
  }
  const parts = selected.map((part) => partEvidence(payload.row, part));
  const blocking = issues.filter(
    (issue) => issue.reason !== 'unsupported_history' && issue.required,
  );
  return {
    residency,
    issues,
    dependencies,
    ...(blocking.length === 0
      ? { value: evidenceOf(payload.row, record, parts, located.kind === 'source') }
      : {}),
  };
}

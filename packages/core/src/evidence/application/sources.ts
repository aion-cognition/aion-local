import { sourceScopeDependencies } from './dependencies.js';
import { verifyParts } from './source-parts.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { scopeSupportsVerifiedEmpty } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  experienceArchiveKey,
  experiencePayloadBytes,
  getExperienceById,
  type ExperienceArchiveRow,
} from '../../infrastructure/sqlite/experience-archive.js';
import {
  findSourcePartByTurnId,
  readSourceParts,
  readSourceRecord,
  type SourcePartRecord,
  type SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { committedSourceStates } from '../../infrastructure/sqlite/source-states.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import {
  hashContent,
  renderEpisodeText,
  renderToolExecution,
} from '../../reflection/domain/content.js';
import { partAddress, type EvidenceAddress, type SourcePartKind } from '../domain/address.js';
import { utf16CodeUnits, utf8Bytes, type RequestBudget } from '../domain/budget.js';
import type { EvidenceIssue, EvidenceResidency, EvidenceUse } from '../domain/result.js';
import { SOURCE_STATE_SCOPE } from '../domain/scopes.js';

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

export type SourceReadRequest = {
  readonly use: EvidenceUse;
  readonly context: CheckedReadContext;
  readonly budget: RequestBudget;
  /** Whether this request needs the source. An optional unit is named without blocking. */
  readonly required: boolean;
};

type Located =
  | { readonly kind: 'source'; readonly sourceId: string }
  | {
      readonly kind: 'part';
      readonly sourceId: string;
      readonly partKind: SourcePartKind;
      readonly ordinal: number;
    };

const SUPPRESSION_KINDS = {
  forget: new Set(['forgotten', 'unforgotten']),
  suppress: new Set(['suppressed', 'unsuppressed']),
};

function issueOn(
  address: EvidenceAddress,
  field: EvidenceIssue['field'],
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required: boolean,
): EvidenceIssue {
  return { address, field, reason, required };
}

/**
 * Which source and part an address names. A part tuple names itself; an id is looked up as a
 * source first and then as an original turn id, because both are ids a caller may hold and
 * neither one can be told from the other by shape.
 */
export function locateAddress(db: SqliteHandle, address: EvidenceAddress): Located | undefined {
  if (address.kind === 'part') {
    return {
      kind: 'part',
      sourceId: address.sourceId,
      partKind: address.partKind,
      ordinal: address.ordinal,
    };
  }
  if (readSourceRecord(db, address.id) !== undefined) {
    return { kind: 'source', sourceId: address.id };
  }
  const part = findSourcePartByTurnId(db, address.id);
  return part === undefined
    ? undefined
    : {
        kind: 'part',
        sourceId: part.sourceId,
        partKind: part.partKind as SourcePartKind,
        ordinal: part.ordinal,
      };
}

export type Eligibility =
  | { readonly status: 'disclosable' }
  | { readonly status: 'suppressed' }
  /** The chain cannot say what was true then, which is a limitation rather than a verdict. */
  | { readonly status: 'unproved' };

/**
 * Whether the source may be disclosed at the moment this read is judged against.
 *
 * Forgetting and suppression are separate chains, so the latest statement on each decides its
 * own axis and either one withholds the content. The chain outlives the content it applies to,
 * which is what lets a question about an evicted source still have an answer.
 *
 * A knowledge-time question is different from a question about now. The chain is append-only, so
 * its emptiness settles the present; it settles an earlier vantage only where a census says the
 * statements up to that vantage were counted. Reading an unbackfilled silence as a proved absence
 * is how a source that was forgotten then comes back now.
 */
export function eligibilityAt(
  db: SqliteHandle,
  sourceId: string,
  context: CheckedReadContext,
): Eligibility {
  const { knownAt } = context.mode;
  const states = committedSourceStates(db, sourceId);
  const visible = states.filter(
    (state) => knownAt === undefined || Date.parse(state.knownFrom) <= knownAt.getTime(),
  );
  const latest = (kinds: ReadonlySet<string>): string | undefined =>
    [...visible].reverse().find((state) => kinds.has(state.stateKind))?.stateKind;
  if (
    latest(SUPPRESSION_KINDS.forget) === 'forgotten' ||
    latest(SUPPRESSION_KINDS.suppress) === 'suppressed'
  ) {
    return { status: 'suppressed' };
  }
  if (knownAt !== undefined && visible.length === 0) {
    return scopeSupportsVerifiedEmpty(db, {
      endpointId: sourceId,
      relationClass: SOURCE_STATE_SCOPE,
    })
      ? { status: 'disclosable' }
      : { status: 'unproved' };
  }
  return { status: 'disclosable' };
}

/**
 * When the substrate first held this occurrence, which is the earliest vantage a knowledge-time
 * read can see it from.
 *
 * The occurrence's own acceptance, not its bytes': a source pushed again after a forget shares
 * the archive row its predecessor wrote, so the archive stamp says when those bytes first
 * arrived and nothing about when this occurrence did. World time is a third question again.
 */
function knownFromRecord(record: SourceRecord): number | undefined {
  const parsed = Date.parse(record.createdAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function residencyOf(db: SqliteHandle, sourceId: string): EvidenceResidency {
  return readSourceResidency(db, sourceId)?.state ?? 'resident';
}

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
  const identity = experienceArchiveKey(row.identity, row.contentHash, row.schemaVersion);
  if (
    identity !== record.identityHash ||
    row.contentHash !== record.verifiedContentDigest ||
    archivedContentDigest(row) !== row.contentHash
  ) {
    return {
      status: 'failed',
      issue: issueOn(address, 'source_content', 'unresolved_mapping', request.required),
    };
  }
  return { status: 'read', row };
}

function partText(row: ExperienceArchiveRow, part: SourcePartRecord): string | undefined {
  const { payload } = row;
  if (part.partKind === 'turn') {
    const turn = (payload.turns ?? [])[part.ordinal];
    return turn === undefined ? undefined : `${turn.role}: ${turn.text}`;
  }
  if (part.partKind === 'observation') {
    const observation = (payload.observations ?? [])[part.ordinal];
    return observation === undefined ? undefined : `observation: ${observation}`;
  }
  const execution = (payload.tool_executions ?? [])[part.ordinal];
  return execution === undefined ? undefined : renderToolExecution(execution).join('\n');
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

/**
 * One address, resolved to verified raw evidence or to the reason it is not there.
 *
 * Suppression is decided before anything is decoded, because a proved suppression is the answer
 * rather than a failure to find one. Indexing is the one purpose that reads past it: the index
 * is a projection, and every path that discloses a hit checks suppression again before it does.
 */
export function resolveSourceEvidence(
  db: SqliteHandle,
  address: EvidenceAddress,
  request: SourceReadRequest,
): SourceResolution {
  const located = locateAddress(db, address);
  if (located === undefined) {
    return {
      residency: 'unknown-mapping',
      issues: [issueOn(address, 'source_content', 'unresolved_mapping', request.required)],
      dependencies: [],
    };
  }
  const record = readSourceRecord(db, located.sourceId);
  if (record === undefined) {
    return {
      residency: 'unknown-mapping',
      issues: [issueOn(address, 'source_content', 'unresolved_mapping', request.required)],
      dependencies: [],
    };
  }
  const residency = residencyOf(db, located.sourceId);
  const dependencies = sourceScopeDependencies(db, located.sourceId);
  const knownFrom = knownFromRecord(record);
  const { knownAt } = request.context.mode;
  if (knownAt !== undefined && knownFrom === undefined) {
    // An unreadable acceptance clock says nothing about whether the source was there then.
    // Unknown availability is a limitation, not an absence.
    return {
      residency,
      issues: [
        {
          address,
          field: 'source_clocks',
          reason: 'unsupported_history',
          historyReason: 'not_recorded',
          required: request.required,
        },
      ],
      dependencies,
    };
  }
  // What the substrate did not hold at the requested vantage is a certified absence there, not
  // content to serve under an earlier date.
  if (knownAt !== undefined && knownFrom !== undefined && knownFrom > knownAt.getTime()) {
    return {
      residency,
      issues: [issueOn(address, 'source_content', 'not_found', request.required)],
      dependencies,
    };
  }
  const eligibility =
    request.use === 'search_indexing'
      ? ({ status: 'disclosable' } as const)
      : eligibilityAt(db, located.sourceId, request.context);
  if (eligibility.status === 'suppressed') {
    return {
      residency,
      issues: [issueOn(address, 'eligibility', 'suppressed_source', request.required)],
      dependencies,
    };
  }
  if (eligibility.status === 'unproved') {
    return {
      residency,
      issues: [
        {
          address,
          field: 'eligibility',
          reason: 'unsupported_history',
          historyReason: 'not_recorded',
          required: request.required,
        },
      ],
      dependencies,
    };
  }

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

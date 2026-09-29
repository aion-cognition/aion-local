import { sourceScopeDependencies } from './dependencies.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { scopeSupportsVerifiedEmpty } from '../../infrastructure/sqlite/evidence-scope.js';
import { experienceArchiveKey } from '../../infrastructure/sqlite/experience-archive.js';
import {
  findSourcePartByTurnId,
  readSourceRecord,
  type SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { committedSourceStates } from '../../infrastructure/sqlite/source-states.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import type { EvidenceAddress, SourcePartKind } from '../domain/address.js';
import type { EvidenceIssue, EvidenceResidency, EvidenceUse } from '../domain/result.js';
import { SOURCE_STATE_SCOPE } from '../domain/scopes.js';

/**
 * Whether an address may be read at all, decided before any archived byte is touched.
 *
 * Which source the address names, whether its records exist, whether it was held at the vantage
 * asked about, and whether it may be disclosed there are all answered from the identity records.
 * A read that fails here never reaches the archive, and a read that passes carries the source
 * scopes it consulted, so a later writer can tell whether any of those answers moved.
 */

export type SourceGateRequest = {
  readonly use: EvidenceUse;
  readonly context: CheckedReadContext;
  /** Whether this request needs the source. An optional unit is named without blocking. */
  readonly required: boolean;
};

export type Located =
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

export function issueOn(
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

export type SourceGate =
  | {
      readonly status: 'closed';
      readonly residency: EvidenceResidency;
      readonly issues: readonly EvidenceIssue[];
      readonly dependencies: readonly EvidenceDependency[];
    }
  | {
      readonly status: 'open';
      readonly located: Located;
      readonly record: SourceRecord;
      readonly residency: EvidenceResidency;
      readonly dependencies: readonly EvidenceDependency[];
    };

/**
 * One address, gated on its records alone.
 *
 * Suppression is decided before anything is decoded, because a proved suppression is the answer
 * rather than a failure to find one. Indexing is the one purpose that reads past it: the index
 * is a projection, and every path that discloses a hit checks suppression again before it does.
 */
export function gateSource(
  db: SqliteHandle,
  address: EvidenceAddress,
  request: SourceGateRequest,
): SourceGate {
  const located = locateAddress(db, address);
  const record = located === undefined ? undefined : readSourceRecord(db, located.sourceId);
  if (located === undefined || record === undefined) {
    return {
      status: 'closed',
      residency: 'unknown-mapping',
      issues: [issueOn(address, 'source_content', 'unresolved_mapping', request.required)],
      dependencies: [],
    };
  }
  const residency = residencyOf(db, located.sourceId);
  const dependencies = sourceScopeDependencies(db, located.sourceId);
  const closed = (issue: EvidenceIssue): SourceGate => ({
    status: 'closed',
    residency,
    issues: [issue],
    dependencies,
  });
  const knownFrom = knownFromRecord(record);
  const { knownAt } = request.context.mode;
  if (knownAt !== undefined && knownFrom === undefined) {
    // An unreadable acceptance clock says nothing about whether the source was there then.
    // Unknown availability is a limitation, not an absence.
    return closed({
      address,
      field: 'source_clocks',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: request.required,
    });
  }
  // What the substrate did not hold at the requested vantage is a certified absence there, not
  // content to serve under an earlier date.
  if (knownAt !== undefined && knownFrom !== undefined && knownFrom > knownAt.getTime()) {
    return closed(issueOn(address, 'source_content', 'not_found', request.required));
  }
  const eligibility =
    request.use === 'search_indexing'
      ? ({ status: 'disclosable' } as const)
      : eligibilityAt(db, located.sourceId, request.context);
  if (eligibility.status === 'suppressed') {
    return closed(issueOn(address, 'eligibility', 'suppressed_source', request.required));
  }
  if (eligibility.status === 'unproved') {
    return closed({
      address,
      field: 'eligibility',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: request.required,
    });
  }
  return { status: 'open', located, record, residency, dependencies };
}

/**
 * Whether an archive row is the one a verified record names: the record has to claim
 * verification, and the row's identity and content digest have to be the ones it verified.
 * Neither check reads the payload, so a reader that decodes one part can still hold the whole
 * row to its proof.
 */
export function archiveProofHolds(
  record: SourceRecord,
  archived: {
    readonly id: string;
    readonly identity: string;
    readonly contentHash: string;
    readonly schemaVersion: number;
  },
): boolean {
  return (
    record.verificationStatus === 'verified' &&
    record.canonicalArchiveId === archived.id &&
    experienceArchiveKey(archived.identity, archived.contentHash, archived.schemaVersion) ===
      record.identityHash &&
    archived.contentHash === record.verifiedContentDigest
  );
}

import type { CoverageRefusal, HistoryCoverage } from '@aion/protocol';

import type { SourceSearchDeps } from './source-search.js';
import { statedCoverage } from '../../evidence/application/reasons.js';
import type { SourceEvidence, SourcePartEvidence } from '../../evidence/application/sources.js';
import {
  idAddress,
  partAddress,
  SOURCE_PART_KINDS,
  type EvidenceAddress,
  type SourcePartKind,
} from '../../evidence/domain/address.js';
import type { EvidenceIssue, EvidenceResult } from '../../evidence/domain/result.js';
import { checkCoverage, CoverageRequestError } from '../../recall/application/coverage-checker.js';
import { requestedLimit, SOURCE_SEARCH_LIMITS, SourceQueryError } from '../domain/source-search.js';

/**
 * `source`: the raw parts of one captured source, in order, over as many pages as the response
 * budget needs.
 *
 * A page is never the whole source and never says it is. The continuation is the part ordinal
 * the page stopped at, so a judge that needs all of it reads all of it and a caller that wanted
 * one exchange stops after one. Identity, verification and disclosure are the resolver's, so an
 * evicted source answers exactly as a resident one does.
 */

export type SourceInspectRequest = {
  /** A source id, an original turn id, or a canonical part address. */
  readonly id?: string;
  readonly part?: {
    readonly sourceId: string;
    readonly partKind: string;
    readonly ordinal: number;
  };
  readonly cursor?: string;
  readonly limit?: number;
  readonly asOf?: string;
  readonly knewAt?: string;
};

export type InspectedPart = {
  readonly partKind: SourcePartKind;
  readonly ordinal: number;
  readonly turnId?: string;
  readonly role?: string;
  readonly text: string;
  readonly occurredAt?: string;
  readonly partClock: 'recorded' | 'not_recorded';
};

export type SourceInspectOutcome =
  | {
      readonly status: 'source';
      readonly sourceId: string;
      readonly sessionId: string;
      readonly occurredAt: string;
      readonly residency: string;
      readonly evidence: string;
      readonly parts: readonly InspectedPart[];
      /** The ordinal position the next page starts at, absent when the source ended here. */
      readonly continuation?: string;
      readonly coverage: HistoryCoverage;
    }
  | {
      readonly status: 'unavailable';
      readonly residency: string;
      readonly evidence: string;
      readonly reasons: readonly EvidenceIssue[];
      readonly coverage: HistoryCoverage;
    }
  | { readonly status: 'coverage_refused'; readonly refusal: CoverageRefusal }
  | {
      readonly status: 'invalid_request';
      readonly field: 'id' | 'part' | 'cursor' | 'limit' | 'as_of' | 'knew_at';
      readonly message: string;
    };

function isPartKind(value: string): value is SourcePartKind {
  return (SOURCE_PART_KINDS as readonly string[]).includes(value);
}

function addressOf(request: SourceInspectRequest): EvidenceAddress {
  if (request.part !== undefined) {
    if (!isPartKind(request.part.partKind)) {
      throw new SourceQueryError('query', `unknown part kind '${request.part.partKind}'`);
    }
    if (!Number.isInteger(request.part.ordinal) || request.part.ordinal < 0) {
      throw new SourceQueryError('query', 'a part ordinal is a whole number from zero');
    }
    return partAddress(request.part.sourceId, request.part.partKind, request.part.ordinal);
  }
  if (request.id === undefined || request.id.trim().length === 0) {
    throw new SourceQueryError('query', 'source needs an id or a part address');
  }
  return idAddress(request.id);
}

function inspected(part: SourcePartEvidence): InspectedPart {
  return {
    partKind: part.partKind,
    ordinal: part.ordinal,
    ...(part.turnId === undefined ? {} : { turnId: part.turnId }),
    ...(part.role === undefined ? {} : { role: part.role }),
    text: part.text,
    ...(part.occurredAt === undefined ? {} : { occurredAt: part.occurredAt }),
    partClock: part.occurredAt === undefined ? 'not_recorded' : 'recorded',
  };
}

/** Where the previous page stopped, as the index into the source's own ordered part list. */
function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SourceQueryError('cursor', 'the continuation is not one this substrate issued');
  }
  return parsed;
}

/**
 * The page this offset reaches, cut on whichever bound arrives first: the caller's part count
 * or the response budget. A single part larger than the whole budget is still returned, because
 * a page that dropped it would report the source as ending before it does.
 */
function pageFrom(
  parts: readonly SourcePartEvidence[],
  offset: number,
  limit: number,
): { readonly page: readonly SourcePartEvidence[]; readonly next: number | undefined } {
  const page: SourcePartEvidence[] = [];
  let bytes = 0;
  let index = offset;
  while (index < parts.length && page.length < limit) {
    const part = parts[index];
    if (part === undefined) {
      break;
    }
    const size = Buffer.byteLength(part.text, 'utf8');
    if (page.length > 0 && bytes + size > SOURCE_SEARCH_LIMITS.maxResponseTextBytes) {
      break;
    }
    page.push(part);
    bytes += size;
    index += 1;
  }
  return { page, next: index < parts.length ? index : undefined };
}

function reasonsOf(result: EvidenceResult<SourceEvidence>): readonly EvidenceIssue[] {
  return result.evidence.status === 'complete-for-use' ? [] : result.evidence.reasons;
}

export async function runSourceInspection(
  deps: SourceSearchDeps,
  request: SourceInspectRequest,
): Promise<SourceInspectOutcome> {
  let address: EvidenceAddress;
  let offset: number;
  let limit: number;
  try {
    address = addressOf(request);
    offset = cursorOffset(request.cursor);
    limit = requestedLimit(request.limit);
  } catch (err) {
    if (err instanceof SourceQueryError) {
      return {
        status: 'invalid_request',
        field: err.field === 'query' ? 'id' : err.field,
        message: err.message,
      };
    }
    throw err;
  }

  const now = deps.now();
  let checked;
  try {
    checked = checkCoverage(deps.db, {
      ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
      ...(request.knewAt === undefined ? {} : { knewAt: request.knewAt }),
      now,
      expiryAnnotation: true,
    });
  } catch (err) {
    if (err instanceof CoverageRequestError) {
      return { status: 'invalid_request', field: err.field, message: err.message };
    }
    throw err;
  }
  if (checked.status === 'refused') {
    return { status: 'coverage_refused', refusal: checked.refusal };
  }

  const batch = await deps.resolver.resolveSources([address], checked.context, 'raw_inspection');
  const result = [...batch.results.values()][0];
  const { coverage } = statedCoverage(checked.coverage, batch.issues);
  if (result === undefined) {
    return {
      status: 'unavailable',
      residency: 'unknown-mapping',
      evidence: 'incomplete',
      reasons: [],
      coverage,
    };
  }
  if (result.value === undefined) {
    return {
      status: 'unavailable',
      residency: result.residency,
      evidence: result.evidence.status,
      reasons: reasonsOf(result),
      coverage,
    };
  }
  const { page, next } = pageFrom(result.value.parts, offset, limit);
  return {
    status: 'source',
    sourceId: result.value.sourceId,
    sessionId: result.value.sessionId,
    occurredAt: result.value.occurredAt,
    residency: result.residency,
    evidence: result.evidence.status,
    parts: page.map(inspected),
    ...(next === undefined ? {} : { continuation: String(next) }),
    coverage,
  };
}

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
  /** This page's slice of the part, which is the whole part when `partComplete` says so. */
  readonly text: string;
  /** UTF-16 offsets into the part, so a caller can join two pages back together exactly. */
  readonly textStart: number;
  readonly textEnd: number;
  readonly partComplete: boolean;
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

function inspected(part: SourcePartEvidence, slice: PartSlice): InspectedPart {
  return {
    partKind: part.partKind,
    ordinal: part.ordinal,
    ...(part.turnId === undefined ? {} : { turnId: part.turnId }),
    ...(part.role === undefined ? {} : { role: part.role }),
    text: slice.text,
    textStart: slice.start,
    textEnd: slice.end,
    /** False while the part continues past this page, so no caller reads a slice as the whole. */
    partComplete: slice.end >= part.text.length,
    ...(part.occurredAt === undefined ? {} : { occurredAt: part.occurredAt }),
    partClock: part.occurredAt === undefined ? 'not_recorded' : 'recorded',
  };
}

/** Where a page stopped: which part, and how far into that part's own text. */
type InspectCursor = {
  readonly index: number;
  readonly offset: number;
};

/**
 * The position a continuation names. A bare number is the part index a page ended before; the
 * dotted form adds the UTF-16 offset inside that part, which is what makes a part larger than
 * one response resumable rather than truncated.
 */
function cursorPosition(cursor: string | undefined): InspectCursor {
  if (cursor === undefined) {
    return { index: 0, offset: 0 };
  }
  const [head, tail] = cursor.split('.');
  const index = Number(head);
  const offset = tail === undefined ? 0 : Number(tail);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new SourceQueryError('cursor', 'the continuation is not one this substrate issued');
  }
  return { index, offset };
}

function encodeCursor(position: InspectCursor): string {
  return `${String(position.index)}.${String(position.offset)}`;
}

type PartSlice = {
  readonly text: string;
  /** UTF-16 offsets into the part, so successive pages join back exactly where they split. */
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
};

/**
 * The longest run of one part's text from `from` that fits in `maxBytes` of UTF-8, cut between
 * code points. A surrogate pair split across two pages would hand each of them half a character
 * and make the two pages fail to reassemble into the part.
 */
function sliceWithinBytes(text: string, from: number, maxBytes: number): PartSlice {
  const rest = text.length - from;
  if (rest <= 0 || maxBytes <= 0) {
    return { text: '', start: from, end: from, bytes: 0 };
  }
  let low = 0;
  let high = rest;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(from, from + mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let take = low;
  const last = text.charCodeAt(from + take - 1);
  if (take > 0 && take < rest && last >= 0xd800 && last <= 0xdbff) {
    take -= 1;
  }
  const slice = text.slice(from, from + take);
  return { text: slice, start: from, end: from + take, bytes: Buffer.byteLength(slice, 'utf8') };
}

type InspectPage = {
  readonly page: readonly InspectedPart[];
  readonly next: InspectCursor | undefined;
};

/**
 * The page this position reaches, cut on whichever bound arrives first: the caller's part count
 * or the response budget.
 *
 * No part is exempt from the budget. A part larger than one response is served in slices and
 * the continuation says where the next one starts, because the alternative — handing back a
 * part that overran the bound, or clipping it silently — is a page that either breaks its own
 * contract or reports the part as shorter than it is.
 */
function pageFrom(
  parts: readonly SourcePartEvidence[],
  from: InspectCursor,
  limit: number,
): InspectPage {
  const page: InspectedPart[] = [];
  let bytes = 0;
  let { index, offset } = from;
  while (index < parts.length && page.length < limit) {
    const part = parts[index];
    if (part === undefined) {
      break;
    }
    const remaining = SOURCE_SEARCH_LIMITS.maxResponseTextBytes - bytes;
    const slice = sliceWithinBytes(part.text, offset, remaining);
    // An empty part is a real part and ends here; an empty slice of a non-empty part means the
    // budget is spent, and the page stops rather than emitting a zero-length reading of it.
    if (slice.text.length === 0 && part.text.length > offset) {
      break;
    }
    page.push(inspected(part, slice));
    bytes += slice.bytes;
    if (slice.end < part.text.length) {
      offset = slice.end;
      break;
    }
    index += 1;
    offset = 0;
  }
  const done = index >= parts.length;
  return { page, next: done ? undefined : { index, offset } };
}

function reasonsOf(result: EvidenceResult<SourceEvidence>): readonly EvidenceIssue[] {
  return result.evidence.status === 'complete-for-use' ? [] : result.evidence.reasons;
}

export async function runSourceInspection(
  deps: SourceSearchDeps,
  request: SourceInspectRequest,
): Promise<SourceInspectOutcome> {
  let address: EvidenceAddress;
  let position: InspectCursor;
  let limit: number;
  try {
    address = addressOf(request);
    position = cursorPosition(request.cursor);
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
  const { page, next } = pageFrom(result.value.parts, position, limit);
  return {
    status: 'source',
    sourceId: result.value.sourceId,
    sessionId: result.value.sessionId,
    occurredAt: result.value.occurredAt,
    residency: result.residency,
    evidence: result.evidence.status,
    parts: page,
    ...(next === undefined ? {} : { continuation: encodeCursor(next) }),
    coverage,
  };
}

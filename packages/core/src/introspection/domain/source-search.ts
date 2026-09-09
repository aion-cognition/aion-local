import { createHash } from 'node:crypto';

import type { SourcePartKind } from '../../evidence/domain/address.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';

/**
 * What an archive search is allowed to ask, how a continuation is spelled, and what one hit
 * says about its own coverage.
 *
 * The grammar is literal text on purpose. A caller's string never reaches SQLite as an
 * expression: it is tokenised here and rebuilt as quoted phrases, so no FTS5 operator and no
 * SQL fragment can arrive through a query. Nothing here promises substring matching, and
 * nothing infers a correction from a near miss.
 */

export const SOURCE_SEARCH_LIMITS = {
  /** Parts returned when the caller names no limit. */
  defaultResults: 20,
  /** The most a caller may ask for in one page. */
  maxResults: 50,
  /** Documents one call may examine, whether or not they survive disclosure. */
  maxExaminedDocuments: 200,
  maxQueryCharacters: 2048,
  /** UTF-8 bytes of excerpt text one response may carry. */
  maxResponseTextBytes: 64 * 1024,
  /** UTF-16 units of one excerpt, which is a window on the part rather than the part. */
  excerptCodeUnits: 240,
} as const;

export type SourceSearchRequest = {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly asOf?: string;
  readonly knewAt?: string;
};

/** A request the substrate will not run, refused before it reads or spends anything. */
export class SourceQueryError extends Error {
  readonly field: 'query' | 'limit' | 'cursor';
  constructor(field: 'query' | 'limit' | 'cursor', message: string) {
    super(message);
    this.field = field;
    this.name = 'SourceQueryError';
  }
}

export type ParsedQuery = {
  /** The terms as the caller wrote them, for the excerpt window and for the digest. */
  readonly terms: readonly string[];
  /** The FTS5 expression: quoted phrases combined with AND, and nothing a caller supplied. */
  readonly matchExpression: string;
};

/** FTS5 quoting: a double quote inside a phrase is doubled, which is the whole escape. */
function quotePhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * The tokens a query names. A double-quoted run is one phrase; everything else splits on
 * whitespace. A token with no alphanumeric character in it cannot match under the tokenizer and
 * is dropped rather than sent, because sending it would return an empty page that reads like a
 * substrate that holds nothing.
 */
function tokenize(raw: string): readonly string[] {
  const terms: string[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === undefined || /\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const close = raw.indexOf('"', index + 1);
      if (close === -1) {
        throw new SourceQueryError('query', 'a quoted phrase is missing its closing quote');
      }
      terms.push(raw.slice(index + 1, close));
      index = close + 1;
      continue;
    }
    const next = raw.slice(index).search(/[\s"]/);
    const end = next === -1 ? raw.length : index + next;
    terms.push(raw.slice(index, end));
    index = end;
  }
  return terms.filter((term) => /[\p{L}\p{N}]/u.test(term));
}

export function parseSearchQuery(raw: string): ParsedQuery {
  if (raw.length > SOURCE_SEARCH_LIMITS.maxQueryCharacters) {
    throw new SourceQueryError(
      'query',
      `a query may be ${String(SOURCE_SEARCH_LIMITS.maxQueryCharacters)} characters at most`,
    );
  }
  const terms = tokenize(raw);
  if (terms.length === 0) {
    throw new SourceQueryError('query', 'a query needs at least one word or number to look for');
  }
  return { terms, matchExpression: terms.map(quotePhrase).join(' AND ') };
}

export function requestedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return SOURCE_SEARCH_LIMITS.defaultResults;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > SOURCE_SEARCH_LIMITS.maxResults) {
    throw new SourceQueryError(
      'limit',
      `limit must be a whole number from 1 to ${String(SOURCE_SEARCH_LIMITS.maxResults)}`,
    );
  }
  return limit;
}

/**
 * Everything a continuation is bound to. A page resumed under a different query, a different
 * read mode, a different coverage epoch or a different index policy is a different search, and
 * carrying the cursor across would splice two answers together.
 */
export type SearchCursor = {
  readonly queryDigest: string;
  readonly indexPolicyVersion: number;
  readonly modeDigest: string;
  readonly coverageEpoch: string;
  readonly generation: number;
  /** The document high-water this search is bound to. Anything above it is a fresh search. */
  readonly upperBound: number;
  /** The last document this search examined, emitted or not. */
  readonly afterId: number;
};

export function queryDigest(parsed: ParsedQuery): string {
  return createHash('sha256').update(JSON.stringify(parsed.terms)).digest('hex').slice(0, 32);
}

/** The read mode a page was assembled under, as a value a later page can be compared against. */
export function modeDigest(mode: ReadMode): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        mode.validAt?.toISOString() ?? null,
        mode.knownAt?.toISOString() ?? null,
        mode.expiryAnnotation !== false,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor this substrate did not produce is refused rather than repaired into something. */
export function decodeSearchCursor(encoded: string): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new SourceQueryError('cursor', 'the continuation is not one this substrate issued');
  }
  const value = parsed as Partial<SearchCursor> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.queryDigest !== 'string' ||
    typeof value.indexPolicyVersion !== 'number' ||
    typeof value.modeDigest !== 'string' ||
    typeof value.coverageEpoch !== 'string' ||
    typeof value.generation !== 'number' ||
    typeof value.upperBound !== 'number' ||
    typeof value.afterId !== 'number'
  ) {
    throw new SourceQueryError('cursor', 'the continuation is not one this substrate issued');
  }
  return {
    queryDigest: value.queryDigest,
    indexPolicyVersion: value.indexPolicyVersion,
    modeDigest: value.modeDigest,
    coverageEpoch: value.coverageEpoch,
    generation: value.generation,
    upperBound: value.upperBound,
    afterId: value.afterId,
  };
}

export type ExcerptWindow = {
  readonly text: string;
  /** UTF-16 offsets into the part, so a caller can point at exactly what it was shown. */
  readonly start: number;
  readonly end: number;
};

/**
 * A bounded window on the part, centred on the first term that appears in it literally.
 *
 * The tokenizer can match a part whose own text spells the term differently, so a term that is
 * nowhere in the raw string leaves the window at the head of the part rather than inventing a
 * position. The offsets are the part's, not the excerpt's, which is what makes them useful for
 * a follow-up read of the whole source.
 */
export function excerptFor(text: string, terms: readonly string[]): ExcerptWindow {
  const haystack = text.toLowerCase();
  const found = terms
    .map((term) => haystack.indexOf(term.toLowerCase()))
    .filter((position) => position >= 0);
  const width = SOURCE_SEARCH_LIMITS.excerptCodeUnits;
  const anchor = found.length === 0 ? 0 : Math.min(...found);
  const start = Math.max(0, anchor - Math.floor(width / 4));
  const end = Math.min(text.length, start + width);
  return { text: text.slice(start, end), start, end };
}

export type SourceSearchHit = {
  readonly sourceId: string;
  readonly partKind: SourcePartKind;
  readonly ordinal: number;
  /** The original graph id, on the parts that had one. Nothing invents one for the others. */
  readonly turnId?: string;
  /** The recorded role, which names a position in the exchange and never a human author. */
  readonly role?: string;
  readonly sessionId: string;
  readonly sourceOccurredAt: string;
  readonly partOccurredAt?: string;
  /** Whether the part's own clock was recorded, kept apart from the source's. */
  readonly partClock: 'recorded' | 'not_recorded';
  readonly excerpt: ExcerptWindow;
  readonly residency: string;
  readonly evidence: string;
  readonly indexedBytes: number;
  /** The index holds a prefix of this part, so a phrase past it is absent from the corpus. */
  readonly truncated: boolean;
};

/** What the corpus could and could not answer for, said on every search including a zero-hit one. */
export type SearchCorpusDisclosure = {
  readonly documents: number;
  readonly truncatedDocuments: number;
  readonly examined: number;
  /** The examination cap or the evidence allowance stopped the pass before the corpus ended. */
  readonly bounded: boolean;
  /** Hits the requested mode withheld, counted rather than silently dropped. */
  readonly withheld: number;
};

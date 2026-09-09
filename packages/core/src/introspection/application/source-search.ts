import type { CoverageRefusal, HistoryCoverage } from '@aion/protocol';

import { statedCoverage } from '../../evidence/application/reasons.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { SourceEvidence, SourcePartEvidence } from '../../evidence/application/sources.js';
import {
  partAddress,
  type EvidenceAddress,
  type SourcePartKind,
} from '../../evidence/domain/address.js';
import type { RequestBudget } from '../../evidence/domain/budget.js';
import type { EvidenceIssue, EvidenceResult } from '../../evidence/domain/result.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  readSearchCapability,
  searchProjectionExists,
  type SearchUnavailableCause,
} from '../../infrastructure/sqlite/fts-capability.js';
import { INDEX_POLICY_VERSION } from '../../infrastructure/sqlite/source-search-schema.js';
import {
  corpusCoverage,
  documentHighWater,
  nominateDocuments,
  searchGeneration,
  type SearchDocument,
} from '../../infrastructure/sqlite/source-search-store.js';
import {
  checkCoverage,
  CoverageRequestError,
  readCoverageFence,
  type CheckedReadContext,
} from '../../recall/application/coverage-checker.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  excerptFor,
  modeDigest,
  parseSearchQuery,
  queryDigest,
  requestedLimit,
  SOURCE_SEARCH_LIMITS,
  SourceQueryError,
  type ParsedQuery,
  type SearchCorpusDisclosure,
  type SourceSearchHit,
  type SourceSearchRequest,
} from '../domain/source-search.js';

/**
 * Archive search: a tool, and only a tool.
 *
 * It nominates addresses out of the full-text projection and then answers about each one
 * through the evidence resolver, which is what applies suppression, residency and the temporal
 * vantage. Ordinary recall gains nothing from it and no seed leg reads it; a caller asks it a
 * question and gets a bounded page with a statement about what the corpus could not answer.
 *
 * Search failing is search failing. A missing extension, a damaged projection, or a corpus that
 * only holds prefixes are all disclosed as themselves, and none of them changes what recall or
 * a judgment does.
 */

export type SourceSearchDeps = {
  readonly db: SqliteHandle;
  readonly resolver: EvidenceResolver;
  readonly now: () => Date;
};

export type SourceSearchOutcome =
  | {
      readonly status: 'results';
      readonly results: readonly SourceSearchHit[];
      readonly continuation?: string;
      readonly coverage: HistoryCoverage;
      readonly corpus: SearchCorpusDisclosure;
    }
  /** The projection replaced a document under the reader. No page and no claim about the old one. */
  | { readonly status: 'restart_required'; readonly reason: 'index_generation_changed' }
  | {
      readonly status: 'search_unavailable';
      readonly cause: SearchUnavailableCause;
      readonly detail: string;
    }
  | { readonly status: 'coverage_refused'; readonly refusal: CoverageRefusal }
  | {
      readonly status: 'invalid_request';
      readonly field: 'query' | 'limit' | 'cursor' | 'as_of' | 'knew_at';
      readonly message: string;
    };

/** One consistent reading of the projection: its generation, its ceiling, and its nominations. */
type Snapshot = {
  readonly generation: number;
  readonly upperBound: number;
  readonly documents: readonly SearchDocument[];
};

function takeSnapshot(
  db: SqliteHandle,
  query: ParsedQuery,
  bounds: { readonly afterId: number; readonly upperBound?: number },
): Snapshot {
  return db.transaction((): Snapshot => {
    const generation = searchGeneration(db);
    const upperBound = bounds.upperBound ?? documentHighWater(db);
    // A substrate nothing has indexed has no projection to query. That is a corpus holding
    // nothing, which the completeness disclosure states, and not a reason to build one here.
    const documents = searchProjectionExists(db)
      ? nominateDocuments(db, {
          matchExpression: query.matchExpression,
          afterId: bounds.afterId,
          upperBound,
          limit: SOURCE_SEARCH_LIMITS.maxExaminedDocuments,
        })
      : [];
    return { generation, upperBound, documents };
  })();
}

function partOf(
  evidence: SourceEvidence,
  document: SearchDocument,
): SourcePartEvidence | undefined {
  return evidence.parts.find(
    (part) => part.partKind === document.partKind && part.ordinal === document.partOrdinal,
  );
}

function hitFor(
  document: SearchDocument,
  evidence: SourceEvidence,
  part: SourcePartEvidence,
  result: EvidenceResult<SourceEvidence>,
  terms: readonly string[],
): SourceSearchHit {
  return {
    sourceId: evidence.sourceId,
    partKind: part.partKind,
    ordinal: part.ordinal,
    ...(part.turnId === undefined ? {} : { turnId: part.turnId }),
    ...(part.role === undefined ? {} : { role: part.role }),
    sessionId: evidence.sessionId,
    sourceOccurredAt: evidence.occurredAt,
    ...(part.occurredAt === undefined ? {} : { partOccurredAt: part.occurredAt }),
    partClock: part.occurredAt === undefined ? 'not_recorded' : 'recorded',
    excerpt: excerptFor(part.text, terms),
    residency: result.residency,
    evidence: result.evidence.status,
    indexedBytes: document.indexedBytes,
    truncated: document.truncated,
  };
}

/**
 * The index cap reported in the caller's own vocabulary. A truncated document and an
 * examination that stopped short are both bounds on what the answer looked at, which is what
 * `bounded_read` says; naming them as anything else would let a partial search read as a
 * settled no-match.
 */
function boundedIssue(address: EvidenceAddress | undefined, sourceId: string): EvidenceIssue {
  return {
    address: address ?? { kind: 'id', id: sourceId },
    field: 'source_content',
    reason: 'budget_limit',
    required: false,
  };
}

/**
 * Whether the request's own allowance, rather than the substrate, is what stopped this reading.
 *
 * A suppressed source, an unresolved mapping and a store outage are answers about the document;
 * an exhausted budget is an answer about the request. Only the second one is worth resuming,
 * and telling them apart is what keeps a large source from disappearing from every page.
 *
 * The batch's issue list is what says so, not the result state: a subread this page did not
 * require reports its exhaustion as an optional issue, so the result still reads
 * complete-for-use while carrying no value at all.
 */
function deferredByBudget(
  result: EvidenceResult<SourceEvidence> | undefined,
  issues: readonly EvidenceIssue[],
): boolean {
  return result?.value === undefined && issues.some((issue) => issue.reason === 'budget_limit');
}

type PageAssembly = {
  readonly hits: readonly SourceSearchHit[];
  readonly issues: readonly EvidenceIssue[];
  readonly lastExamined: number;
  readonly examined: number;
  readonly withheld: number;
  readonly bounded: boolean;
};

/**
 * The examined documents turned into hits, in nomination order, under the response's text
 * budget. The cursor advances over every document the pass examined and not only over the ones
 * that survived disclosure: a page whose hits were all withheld still made progress, and a
 * cursor that stood still would hand the same withheld rows back forever.
 */
async function assemblePage(
  deps: SourceSearchDeps,
  snapshot: Snapshot,
  context: CheckedReadContext,
  query: ParsedQuery,
  limit: number,
  budget: RequestBudget,
): Promise<PageAssembly> {
  const hits: SourceSearchHit[] = [];
  const issues: EvidenceIssue[] = [];
  let lastExamined = 0;
  let examined = 0;
  let withheld = 0;
  let bytes = 0;
  let bounded = snapshot.documents.length >= SOURCE_SEARCH_LIMITS.maxExaminedDocuments;

  for (const document of snapshot.documents) {
    if (hits.length >= limit) {
      bounded = true;
      break;
    }
    const address = partAddress(
      document.sourceId,
      document.partKind as SourcePartKind,
      document.partOrdinal,
    );
    const batch = await deps.resolver.resolveSources([address], context, 'raw_inspection', {
      required: false,
      budget,
    });
    const result = [...batch.results.values()][0];
    // An allowance that ran out is not an answer about this document. Advancing the cursor
    // past it would drop it from every page a caller could ever ask for, so the page stops
    // here instead and the continuation resumes on it with a fresh allowance.
    const deferred = deferredByBudget(result, batch.issues);
    if (deferred && examined > 0) {
      bounded = true;
      break;
    }
    examined += 1;
    lastExamined = document.id;
    issues.push(...batch.issues);
    if (result?.value === undefined) {
      withheld += 1;
      // A whole allowance that cannot carry one document is a bound on the document, not on
      // the page: no later page could read it either, so it is disclosed and stepped over.
      if (deferred) {
        bounded = true;
        break;
      }
      continue;
    }
    const part = partOf(result.value, document);
    if (part === undefined) {
      withheld += 1;
      continue;
    }
    const hit = hitFor(document, result.value, part, result, query.terms);
    const size = Buffer.byteLength(hit.excerpt.text, 'utf8');
    if (bytes + size > SOURCE_SEARCH_LIMITS.maxResponseTextBytes && hits.length > 0) {
      bounded = true;
      break;
    }
    bytes += size;
    hits.push(hit);
    if (document.truncated) {
      issues.push(boundedIssue(address, document.sourceId));
    }
  }
  return { hits, issues, lastExamined, examined, withheld, bounded };
}

type RequestField = 'query' | 'limit' | 'cursor' | 'as_of' | 'knew_at';

function refused(field: RequestField, message: string): SourceSearchOutcome {
  return { status: 'invalid_request', field, message };
}

/**
 * One search. The order is the contract: nothing about the substrate is read until the request
 * is one the substrate will run, and nothing is disclosed until the coverage record that was in
 * force when the page began is still the one in force when it ends.
 */
export async function runSourceSearch(
  deps: SourceSearchDeps,
  request: SourceSearchRequest,
): Promise<SourceSearchOutcome> {
  let query: ParsedQuery;
  let limit: number;
  try {
    query = parseSearchQuery(request.query);
    limit = requestedLimit(request.limit);
  } catch (err) {
    if (err instanceof SourceQueryError) {
      return refused(err.field, err.message);
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
    // A date outside the protocol grammar is a usage error, not a statement about coverage.
    if (err instanceof CoverageRequestError) {
      return refused(err.field, err.message);
    }
    throw err;
  }
  if (checked.status === 'refused') {
    return { status: 'coverage_refused', refusal: checked.refusal };
  }

  // Read-only, and after the refusal: a request the substrate will not answer must leave the
  // substrate exactly as it found it, projection included.
  const capability = readSearchCapability(deps.db);
  if (capability.status !== 'available') {
    return { status: 'search_unavailable', cause: capability.cause, detail: capability.detail };
  }

  const digest = queryDigest(query);
  const mode = modeDigest(checked.context.mode);
  let afterId = 0;
  let upperBound: number | undefined;
  let boundGeneration: number | undefined;
  if (request.cursor !== undefined) {
    let cursor;
    try {
      cursor = decodeSearchCursor(request.cursor);
    } catch (err) {
      if (err instanceof SourceQueryError) {
        return refused(err.field, err.message);
      }
      throw err;
    }
    if (
      cursor.queryDigest !== digest ||
      cursor.modeDigest !== mode ||
      cursor.indexPolicyVersion !== INDEX_POLICY_VERSION
    ) {
      return refused('cursor', 'the continuation belongs to a different search');
    }
    if (cursor.coverageEpoch !== checked.context.coverageEpoch) {
      return {
        status: 'coverage_refused',
        refusal: coverageChanged(checked.coverage, now, request),
      };
    }
    ({ afterId, upperBound, generation: boundGeneration } = cursor);
  }

  const snapshot = takeSnapshot(deps.db, query, {
    afterId,
    ...(upperBound === undefined ? {} : { upperBound }),
  });
  if (boundGeneration !== undefined && boundGeneration !== snapshot.generation) {
    return { status: 'restart_required', reason: 'index_generation_changed' };
  }

  const budget = deps.resolver.newBudget();
  const page = await assemblePage(deps, snapshot, checked.context, query, limit, budget);

  // The coverage record outranks the index: a contract that moved makes the whole answer one
  // the substrate no longer stands behind, and calling that an index restart would send a
  // caller to retry a page it may not be entitled to at all.
  if (readCoverageFence(deps.db) !== checked.context.coverageEpoch) {
    return { status: 'coverage_refused', refusal: coverageChanged(checked.coverage, now, request) };
  }
  if (searchGeneration(deps.db) !== snapshot.generation) {
    return { status: 'restart_required', reason: 'index_generation_changed' };
  }

  const corpusReading = corpusCoverage(deps.db);
  const issues = [...page.issues];
  // A suffix past the index cap is missing from every search, including one that matched
  // nothing at all: without this line an empty page would read as a settled absence.
  if (corpusReading.truncatedDocuments > 0 || page.bounded) {
    issues.push(boundedIssue(undefined, 'source_search_corpus'));
  }
  const { coverage } = statedCoverage(checked.coverage, issues);
  const more = page.bounded && page.lastExamined > 0;
  return {
    status: 'results',
    results: page.hits,
    ...(more
      ? {
          continuation: encodeSearchCursor({
            queryDigest: digest,
            indexPolicyVersion: INDEX_POLICY_VERSION,
            modeDigest: mode,
            coverageEpoch: checked.context.coverageEpoch,
            generation: snapshot.generation,
            upperBound: snapshot.upperBound,
            afterId: page.lastExamined,
          }),
        }
      : {}),
    coverage,
    corpus: {
      documents: corpusReading.documents,
      truncatedDocuments: corpusReading.truncatedDocuments,
      examined: page.examined,
      bounded: page.bounded,
      withheld: page.withheld,
    },
  };
}

/** C10's own outcome for a contract that moved under a read, spelled the way the checker does. */
function coverageChanged(
  coverage: HistoryCoverage,
  now: Date,
  request: SourceSearchRequest,
): CoverageRefusal {
  return {
    contract_version: coverage.contract_version,
    reason: 'coverage_changed',
    requested: {
      ...(request.asOf === undefined ? {} : { as_of: request.asOf }),
      ...(request.knewAt === undefined ? {} : { knew_at: request.knewAt }),
      now: now.toISOString(),
    },
    bounds: {
      ...(coverage.history_since === undefined ? {} : { history_since: coverage.history_since }),
    },
  };
}

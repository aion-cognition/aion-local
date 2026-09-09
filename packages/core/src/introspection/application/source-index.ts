import { createHash } from 'node:crypto';

import type { SourceSearchDeps } from './source-search.js';
import type { SourcePartEvidence } from '../../evidence/application/sources.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import {
  ensureSearchProjection,
  type SearchUnavailableCause,
} from '../../infrastructure/sqlite/fts-capability.js';
import {
  listEvidenceAcknowledgments,
  recordEvidenceAcknowledgment,
  SOURCE_INDEX_EFFECT,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  INDEX_BATCH_BYTES,
  INDEX_BATCH_PARTS,
  INDEX_MAX_PART_BYTES,
} from '../../infrastructure/sqlite/source-search-schema.js';
import {
  LIVE_INDEX_STREAM,
  readIndexProgress,
  recordIndexProgress,
  writeSearchDocument,
} from '../../infrastructure/sqlite/source-search-store.js';
import { checkCoverage } from '../../recall/application/coverage-checker.js';

/**
 * The `source_index` handler: the other half of the acceptance effect intake enqueues.
 *
 * Intake's job is to create the durable obligation and stop. This is what discharges it, one
 * bounded batch at a time, through the queue's own lease and dispatch. Nothing here extracts,
 * rebuilds a projection, or touches the graph, and a failure leaves the obligation exactly
 * where it was: a source whose index is incomplete stays pinned against eviction, and losing
 * the capability is an availability condition rather than permission to forget the work.
 *
 * The read goes through the resolver's internal indexing purpose, which reads verified bytes
 * for projection maintenance without applying disclosure-time suppression. Every path that
 * discloses a hit checks suppression again, so a forgotten source is indexed and withheld
 * rather than left findable by its absence from the corpus.
 */

export type SourceIndexDeps = SourceSearchDeps & {
  readonly logger: Pick<Logger, 'warn' | 'debug'>;
};

export type SourceIndexRequest = {
  readonly sourceId: string;
  /** Which cursor this run advances. The cohort migration keeps one of its own. */
  readonly stream?: string;
};

export type SourceIndexOutcome =
  | {
      readonly status: 'indexed';
      readonly documents: number;
      readonly replaced: number;
      readonly truncated: number;
      readonly indexedBytes: number;
      /** Whether every recorded part now has a current document. */
      readonly complete: boolean;
    }
  /** The obligation stands and the job is owed again; nothing about the source changed. */
  | {
      readonly status: 'search_unavailable';
      readonly cause: SearchUnavailableCause;
      readonly detail: string;
    }
  | { readonly status: 'unresolved'; readonly reasons: readonly EvidenceIssue[] };

/** The 0x80-0xBF range UTF-8 uses for the trailing bytes of a multi-byte character. */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/**
 * The longest valid UTF-8 prefix inside the cap. Cutting on a byte count alone would split a
 * multi-byte character and store a replacement glyph the archive never held, so the cut walks
 * back over continuation bytes to the character boundary before it.
 */
export function utf8Prefix(
  text: string,
  maxBytes: number,
): { readonly body: string; readonly bytes: number; readonly truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return { body: text, bytes: encoded.length, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && isContinuation(encoded[end])) {
    end -= 1;
  }
  return { body: encoded.subarray(0, end).toString('utf8'), bytes: end, truncated: true };
}

/** What a stored document is compared against, so an unchanged part is never rewritten. */
function bodyDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The part this stream stopped after, as an index into the source's own ordered part list. */
function resumeAt(cursor: string | undefined, sourceId: string): number {
  if (!cursor?.startsWith(`${sourceId}:`)) {
    return 0;
  }
  const parsed = Number(cursor.slice(sourceId.length + 1));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Every owed acknowledgment for this source, discharged once the whole source is indexed. */
function settleObligation(deps: SourceIndexDeps, sourceId: string, at: Date): void {
  for (const acknowledgment of listEvidenceAcknowledgments(deps.db, sourceId)) {
    if (acknowledgment.effectKind !== SOURCE_INDEX_EFFECT || acknowledgment.state === 'completed') {
      continue;
    }
    recordEvidenceAcknowledgment(deps.db, {
      sourceId,
      referenceVersion: acknowledgment.referenceVersion,
      effectKind: SOURCE_INDEX_EFFECT,
      state: 'completed',
      completedAt: at,
    });
  }
}

type BatchTally = {
  documents: number;
  replaced: number;
  truncated: number;
  indexedBytes: number;
};

/**
 * One bounded pass over a source's parts.
 *
 * A part whose whole text will not fit in what the batch has left is deferred to the next
 * batch rather than cut down to fill this one: truncation is a property of the index cap and
 * of nothing else, and a part shortened to fit a schedule would look identical to a part the
 * archive really does exceed.
 */
function indexBatch(
  deps: SourceIndexDeps,
  sourceId: string,
  parts: readonly SourcePartEvidence[],
  from: number,
): { readonly tally: BatchTally; readonly stoppedAt: number } {
  const tally: BatchTally = { documents: 0, replaced: 0, truncated: 0, indexedBytes: 0 };
  let index = from;
  while (index < parts.length && tally.documents < INDEX_BATCH_PARTS) {
    const part = parts[index];
    if (part === undefined) {
      break;
    }
    const prefix = utf8Prefix(part.text, INDEX_MAX_PART_BYTES);
    if (tally.documents > 0 && tally.indexedBytes + prefix.bytes > INDEX_BATCH_BYTES) {
      break;
    }
    const write = writeSearchDocument(deps.db, {
      sourceId,
      partKind: part.partKind,
      partOrdinal: part.ordinal,
      contentDigest: bodyDigest(prefix.body),
      body: prefix.body,
      truncated: prefix.truncated,
      indexedBytes: prefix.bytes,
    });
    tally.documents += 1;
    tally.indexedBytes += prefix.bytes;
    if (write === 'replaced') {
      tally.replaced += 1;
    }
    if (prefix.truncated) {
      tally.truncated += 1;
    }
    index += 1;
  }
  return { tally, stoppedAt: index };
}

/**
 * One run of the handler. It returns rather than throwing on an unavailable capability or an
 * unreadable source, because both leave work owed and the caller decides whether that means a
 * released lease or a retry.
 */
export async function runSourceIndexJob(
  deps: SourceIndexDeps,
  request: SourceIndexRequest,
): Promise<SourceIndexOutcome> {
  const stream = request.stream ?? LIVE_INDEX_STREAM;
  const capability = ensureSearchProjection(deps.db);
  if (capability.status !== 'available') {
    return { status: 'search_unavailable', cause: capability.cause, detail: capability.detail };
  }

  const now = deps.now();
  const checked = checkCoverage(deps.db, { now, expiryAnnotation: true });
  if (checked.status === 'refused') {
    return { status: 'unresolved', reasons: [] };
  }

  const batch = await deps.resolver.resolveSources(
    [idAddress(request.sourceId)],
    checked.context,
    'search_indexing',
  );
  const result = [...batch.results.values()][0];
  if (result?.value === undefined) {
    return { status: 'unresolved', reasons: batch.issues };
  }

  const parts = [...result.value.parts].sort(
    (left, right) => left.partKind.localeCompare(right.partKind) || left.ordinal - right.ordinal,
  );
  const from = resumeAt(readIndexProgress(deps.db, stream)?.cursor, request.sourceId);
  const { tally, stoppedAt } = indexBatch(deps, request.sourceId, parts, from);
  const complete = stoppedAt >= parts.length;
  recordIndexProgress(deps.db, {
    stream,
    cursor: complete ? '' : `${request.sourceId}:${String(stoppedAt)}`,
    state: complete ? 'idle' : 'running',
  });
  if (complete) {
    settleObligation(deps, request.sourceId, now);
  }
  deps.logger.debug(
    { sourceId: request.sourceId, stream, ...tally, complete },
    'source index batch written',
  );
  return { status: 'indexed', ...tally, complete };
}

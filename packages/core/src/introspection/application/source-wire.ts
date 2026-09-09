import {
  SOURCE_TOOL_SCHEMA_VERSION,
  type SourceOutput,
  type SourceSearchHitWire,
  type SourceSearchOutput,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import type { SourceInspectOutcome } from './source-inspect.js';
import type { SourceSearchDeps, SourceSearchOutcome } from './source-search.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { SourceSearchHit } from '../domain/source-search.js';

/**
 * The one crossing between what the handlers decided and what the two transports send.
 *
 * A refusal or an unavailable branch is a shape of its own on the wire, so a consumer branches
 * on `status` rather than inferring from an empty list. Both transports call this, which is
 * what keeps the command line and the tool saying the same thing about the same answer.
 */

/**
 * The deps both archive reads take, built where the resolver lives so a transport never
 * constructs a second one. No publication position is taken: these are reads that decide
 * nothing, and a pending publication degrades an answer here rather than blocking it.
 */
export function sourceReadDeps(input: {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
  readonly now?: () => Date;
}): SourceSearchDeps & { readonly logger: Logger } {
  return {
    db: input.db,
    resolver: new EvidenceResolver({ driver: input.driver, db: input.db, logger: input.logger }),
    now: input.now ?? ((): Date => new Date()),
    logger: input.logger,
  };
}

function hitWire(hit: SourceSearchHit): SourceSearchHitWire {
  return {
    source_id: hit.sourceId,
    part_kind: hit.partKind,
    ordinal: hit.ordinal,
    ...(hit.turnId === undefined ? {} : { turn_id: hit.turnId }),
    ...(hit.role === undefined ? {} : { role: hit.role }),
    session_id: hit.sessionId,
    source_occurred_at: hit.sourceOccurredAt,
    ...(hit.partOccurredAt === undefined ? {} : { part_occurred_at: hit.partOccurredAt }),
    part_clock: hit.partClock,
    excerpt: hit.excerpt.text,
    excerpt_start: hit.excerpt.start,
    excerpt_end: hit.excerpt.end,
    residency: hit.residency,
    evidence: hit.evidence,
    indexed_bytes: hit.indexedBytes,
    truncated: hit.truncated,
  };
}

export function searchOutputFor(outcome: SourceSearchOutcome): SourceSearchOutput {
  const version = SOURCE_TOOL_SCHEMA_VERSION;
  switch (outcome.status) {
    case 'results':
      return {
        schema_version: version,
        status: 'results',
        results: outcome.results.map(hitWire),
        ...(outcome.continuation === undefined ? {} : { continuation: outcome.continuation }),
        coverage: outcome.coverage,
        corpus: {
          documents: outcome.corpus.documents,
          truncated_documents: outcome.corpus.truncatedDocuments,
          unindexed_parts: outcome.corpus.unindexedParts,
          examined: outcome.corpus.examined,
          bounded: outcome.corpus.bounded,
          withheld: outcome.corpus.withheld,
        },
      };
    case 'restart_required':
      return { schema_version: version, status: 'restart_required', reason: outcome.reason };
    case 'search_unavailable':
      return {
        schema_version: version,
        status: 'search_unavailable',
        cause: outcome.cause,
        detail: outcome.detail,
      };
    case 'coverage_refused':
      return {
        schema_version: version,
        status: 'coverage_refusal',
        coverage_refusal: outcome.refusal,
      };
    case 'invalid_request':
      return {
        schema_version: version,
        status: 'invalid_request',
        field: outcome.field,
        message: outcome.message,
      };
  }
}

export function sourceOutputFor(outcome: SourceInspectOutcome): SourceOutput {
  const version = SOURCE_TOOL_SCHEMA_VERSION;
  switch (outcome.status) {
    case 'source':
      return {
        schema_version: version,
        status: 'source',
        source_id: outcome.sourceId,
        session_id: outcome.sessionId,
        occurred_at: outcome.occurredAt,
        residency: outcome.residency,
        evidence: outcome.evidence,
        parts: outcome.parts.map((part) => ({
          part_kind: part.partKind,
          ordinal: part.ordinal,
          ...(part.turnId === undefined ? {} : { turn_id: part.turnId }),
          ...(part.role === undefined ? {} : { role: part.role }),
          text: part.text,
          text_start: part.textStart,
          text_end: part.textEnd,
          part_complete: part.partComplete,
          ...(part.occurredAt === undefined ? {} : { occurred_at: part.occurredAt }),
          part_clock: part.partClock,
        })),
        ...(outcome.continuation === undefined ? {} : { continuation: outcome.continuation }),
        coverage: outcome.coverage,
      };
    case 'unavailable':
      return {
        schema_version: version,
        status: 'unavailable',
        residency: outcome.residency,
        evidence: outcome.evidence,
        reasons: outcome.reasons.map((issue) => ({ field: issue.field, reason: issue.reason })),
        coverage: outcome.coverage,
      };
    case 'coverage_refused':
      return {
        schema_version: version,
        status: 'coverage_refusal',
        coverage_refusal: outcome.refusal,
      };
    case 'invalid_request':
      return {
        schema_version: version,
        status: 'invalid_request',
        field: outcome.field,
        message: outcome.message,
      };
  }
}

/**
 * Captured control characters, made visible rather than emitted.
 *
 * A hit is somebody's captured text, and a terminal that receives it executes what it holds:
 * an escape sequence in a stored conversation would move the cursor, clear the screen, or set
 * a title on its way through a rendered block. The structured field keeps the exact bytes the
 * archive holds, because that is what the API promises; the block a person reads does not.
 *
 * Newline and tab are left alone. They are layout in a multi-line part render, and the excerpt
 * line collapses whitespace before it gets here, so nothing escapes into a single-line hit.
 */
function escapeControls(text: string): string {
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    escaped += control ? `\\x${code.toString(16).padStart(2, '0')}` : character;
  }
  return escaped;
}

/**
 * The rendered block beside the structured answer. A refusal reads as a refusal in text too:
 * a client that only renders the block would otherwise be told nothing was found.
 */
export function searchText(output: SourceSearchOutput): string {
  switch (output.status) {
    case 'results': {
      const results = output.results ?? [];
      const { corpus } = output;
      const lines = results.map(
        (hit) =>
          `${hit.source_id} ${hit.part_kind}:${String(hit.ordinal)}` +
          `${hit.truncated ? ' (indexed prefix only)' : ''}  ${escapeControls(hit.excerpt.replace(/\s+/g, ' '))}`,
      );
      const head =
        results.length === 0 ? 'no parts matched' : `${String(results.length)} part(s) matched`;
      const bound = corpus?.bounded === true ? '; the corpus was not read to the end' : '';
      const cut =
        corpus !== undefined && corpus.truncated_documents > 0
          ? `; ${String(corpus.truncated_documents)} indexed part(s) hold a prefix only`
          : '';
      const missing =
        corpus !== undefined && (corpus.unindexed_parts ?? 0) > 0
          ? `; ${String(corpus.unindexed_parts)} captured part(s) are not indexed yet`
          : '';
      const withheld =
        corpus !== undefined && corpus.withheld > 0
          ? `; ${String(corpus.withheld)} withheld in this mode`
          : '';
      return [`${head}${bound}${cut}${missing}${withheld}`, ...lines].join('\n');
    }
    case 'restart_required':
      return 'the search index changed under this page; run the search again from the start';
    case 'search_unavailable':
      return `archive search is unavailable (${output.cause ?? 'unknown'}): ${output.detail ?? ''}`;
    case 'coverage_refusal':
      return `refused: ${output.coverage_refusal?.reason ?? 'coverage_store_unavailable'}`;
    case 'invalid_request':
      return `${output.field ?? 'request'}: ${output.message ?? 'refused'}`;
  }
}

export function sourceText(output: SourceOutput): string {
  switch (output.status) {
    case 'source': {
      const head =
        `${output.source_id ?? ''} (${output.residency ?? ''}, ${output.evidence ?? ''})` +
        ` ${output.occurred_at ?? ''}`;
      const parts = (output.parts ?? []).map((part) => {
        const role = part.role === undefined ? '' : ` [${part.role}]`;
        // A slice says so in the rendered block too. Without it a paged part reads as the
        // whole of what the source holds, which is exactly what the offsets exist to prevent.
        const span = part.part_complete
          ? ''
          : ` [chars ${String(part.text_start)}-${String(part.text_end)}, continues]`;
        return `  ${part.part_kind}:${String(part.ordinal)}${role}${span}\n    ${escapeControls(part.text)}`;
      });
      const more =
        output.continuation === undefined
          ? ''
          : `\n  more parts follow; continue from ${output.continuation}`;
      return [head, ...parts].join('\n') + more;
    }
    case 'unavailable': {
      const named = (output.reasons ?? [])
        .map((issue) => `${issue.field}=${issue.reason}`)
        .join(', ');
      return `no source served (${output.residency ?? ''}, ${output.evidence ?? ''})${
        named === '' ? '' : `: ${named}`
      }`;
    }
    case 'coverage_refusal':
      return `refused: ${output.coverage_refusal?.reason ?? 'coverage_store_unavailable'}`;
    case 'invalid_request':
      return `${output.field ?? 'request'}: ${output.message ?? 'refused'}`;
  }
}

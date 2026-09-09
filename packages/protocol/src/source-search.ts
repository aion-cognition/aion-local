import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';
import { CoverageRefusalSchema, HistoryCoverageSchema } from './history-coverage.js';

/**
 * The wire shapes for the two archive tools.
 *
 * `schema_version` is theirs alone and starts at 1: these are new surfaces, and the coverage
 * contract version they carry inside their statements is a separate number that says how far
 * back the substrate reaches. Recall's own success shape is untouched.
 *
 * Both answers lead with `status`, and a consumer branches on it. A search that could not run,
 * a page whose index moved, and a page of hits are different things, and a consumer that had to
 * infer which one it held from an empty array would read every one of them as "nothing found".
 */

export const SOURCE_TOOL_SCHEMA_VERSION = 1;

export const SourcePartKindSchema = z.enum(['turn', 'observation', 'tool_execution']);

export const SourceSearchInputSchema = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  /** A continuation this substrate issued. Anything else is refused rather than repaired. */
  cursor: z.string().min(1).optional(),
  as_of: IsoTimestampSchema.optional(),
  knew_at: IsoTimestampSchema.optional(),
});

export type SourceSearchInput = z.infer<typeof SourceSearchInputSchema>;

export const SourceInputSchema = z.strictObject({
  id: z.string().min(1).optional(),
  part: z
    .strictObject({
      source_id: z.string().min(1),
      part_kind: SourcePartKindSchema,
      ordinal: z.number().int().nonnegative(),
    })
    .optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  as_of: IsoTimestampSchema.optional(),
  knew_at: IsoTimestampSchema.optional(),
});

export type SourceInput = z.infer<typeof SourceInputSchema>;

/**
 * `excerpt_start` and `excerpt_end` are UTF-16 offsets into the part, not into the excerpt, so
 * a caller can ask for the whole part and point at exactly what it was shown.
 */
export const SourceSearchHitSchema = z.strictObject({
  source_id: z.string(),
  part_kind: SourcePartKindSchema,
  ordinal: z.number().int().nonnegative(),
  turn_id: z.string().optional(),
  /** A position in the exchange. It never identifies a human author. */
  role: z.string().optional(),
  session_id: z.string(),
  source_occurred_at: z.string(),
  part_occurred_at: z.string().optional(),
  part_clock: z.enum(['recorded', 'not_recorded']),
  excerpt: z.string(),
  excerpt_start: z.number().int().nonnegative(),
  excerpt_end: z.number().int().nonnegative(),
  residency: z.string(),
  evidence: z.string(),
  indexed_bytes: z.number().int().nonnegative(),
  /** The index holds a prefix of this part, so a phrase past it is absent from the corpus. */
  truncated: z.boolean(),
});

export type SourceSearchHitWire = z.infer<typeof SourceSearchHitSchema>;

export const SearchCorpusSchema = z.strictObject({
  documents: z.number().int().nonnegative(),
  truncated_documents: z.number().int().nonnegative(),
  examined: z.number().int().nonnegative(),
  bounded: z.boolean(),
  withheld: z.number().int().nonnegative(),
});

/**
 * One object rather than a union of five, because a tool's output schema is a JSON Schema
 * object and a union converts to `anyOf`. `status` is the discriminator a consumer branches on,
 * and the fields below it are present exactly for the status that owns them. `results` is
 * absent rather than empty on every non-result status: an empty list is an answer, and a search
 * that could not run has not made one.
 */
export const SourceSearchOutputSchema = z.strictObject({
  schema_version: z.literal(SOURCE_TOOL_SCHEMA_VERSION),
  status: z.enum([
    'results',
    'restart_required',
    'search_unavailable',
    'coverage_refusal',
    'invalid_request',
  ]),
  results: z.array(SourceSearchHitSchema).optional(),
  continuation: z.string().optional(),
  coverage: HistoryCoverageSchema.optional(),
  corpus: SearchCorpusSchema.optional(),
  /** Present on `restart_required`: the index replaced a document under the reader. */
  reason: z.literal('index_generation_changed').optional(),
  /** Present on `search_unavailable`, and never conflated with an empty result. */
  cause: z.enum(['fts5_unavailable', 'search_store_error']).optional(),
  detail: z.string().optional(),
  coverage_refusal: CoverageRefusalSchema.optional(),
  field: z.string().optional(),
  message: z.string().optional(),
});

export type SourceSearchOutput = z.infer<typeof SourceSearchOutputSchema>;

/**
 * `text_start` and `text_end` are UTF-16 offsets into the part. A part larger than one response
 * arrives over several pages, and these are what join them back together; `part_complete` says
 * whether this page carried the end of it.
 */
export const InspectedPartSchema = z.strictObject({
  part_kind: SourcePartKindSchema,
  ordinal: z.number().int().nonnegative(),
  turn_id: z.string().optional(),
  role: z.string().optional(),
  text: z.string(),
  text_start: z.number().int().nonnegative(),
  text_end: z.number().int().nonnegative(),
  part_complete: z.boolean(),
  occurred_at: z.string().optional(),
  part_clock: z.enum(['recorded', 'not_recorded']),
});

/** Shaped like the search output and for the same reason: one object, `status` decides. */
export const SourceOutputSchema = z.strictObject({
  schema_version: z.literal(SOURCE_TOOL_SCHEMA_VERSION),
  status: z.enum(['source', 'unavailable', 'coverage_refusal', 'invalid_request']),
  source_id: z.string().optional(),
  session_id: z.string().optional(),
  occurred_at: z.string().optional(),
  residency: z.string().optional(),
  evidence: z.string().optional(),
  parts: z.array(InspectedPartSchema).optional(),
  /** Present while the source continues. No page is ever the whole source. */
  continuation: z.string().optional(),
  coverage: HistoryCoverageSchema.optional(),
  reasons: z.array(z.strictObject({ field: z.string(), reason: z.string() })).optional(),
  coverage_refusal: CoverageRefusalSchema.optional(),
  field: z.string().optional(),
  message: z.string().optional(),
});

export type SourceOutput = z.infer<typeof SourceOutputSchema>;

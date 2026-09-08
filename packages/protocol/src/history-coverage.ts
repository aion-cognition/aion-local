import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';

/**
 * What an answer says about the history behind it.
 *
 * A read of the past can be supported, partial, or outside what the substrate promises, and a
 * caller cannot tell those apart from the items alone: a thin answer under a missing field
 * reads exactly like a thin answer under a query nothing matches. The coverage statement is
 * how the answer says which one it is, in the same words in text and in JSON.
 *
 * The wire version stays 1 while the substrate's own coverage record advances. A revision
 * changes how far back the substrate reaches, not the shape the answer is spoken in.
 */
export const COVERAGE_CONTRACT_VERSION = 1;

/**
 * The field groups a gap is named against. Closed, because a free-form field name gives a
 * consumer nothing to branch on and two callers would spell the same absence differently.
 * A source identity or content failure is `source_content`; a missing ancestry scope is
 * `link_interval`.
 */
export const CoverageFieldSchema = z.enum([
  'source_content',
  'source_clocks',
  'reference_history',
  'link_interval',
  'ownership',
  'narrative_revision',
  'representation_preference',
  'interpretation_text',
  'eligibility',
]);

export type CoverageField = z.infer<typeof CoverageFieldSchema>;

/**
 * Why one field is missing. The first four historical causes are proved from the record that
 * should have held the value; nothing here is a guess about why history is absent. An unknown
 * mapping stays separate from a store outage, and a missing census or version proof
 * (`unverified_scope`) stays separate from both: they are repaired by different work.
 */
export const CoverageGapReasonSchema = z.enum([
  'not_recorded',
  'unversioned_legacy',
  'erased_interval',
  'outside_field_policy',
  'unresolved_mapping',
  'store_unavailable',
  'pending_publication',
  'unverified_scope',
  'unresolved_reference',
  'bounded_read',
  'required_scope_missing',
]);

export type CoverageGapReason = z.infer<typeof CoverageGapReasonSchema>;

/** The causes a missing historical value may name, each proved by the field's own record. */
export const HISTORY_GAP_REASONS = [
  'not_recorded',
  'unversioned_legacy',
  'erased_interval',
  'outside_field_policy',
] as const satisfies readonly CoverageGapReason[];

export type HistoryGapReason = (typeof HISTORY_GAP_REASONS)[number];

/**
 * Statements about the answer as a whole rather than about one field. Closed for the same
 * reason the gap reasons are: a caller branches on these.
 */
export const CoverageLimitationSchema = z.enum([
  'coverage_contract_not_active',
  'gap_list_truncated',
]);

export type CoverageLimitation = z.infer<typeof CoverageLimitationSchema>;

/**
 * `id` is the resolved node or source id, or the canonical part address. Two parts of one
 * source stay two gaps: collapsing them to the source id they share would report one absence
 * where there are two.
 */
export const CoverageGapSchema = z.strictObject({
  id: z.string().min(1).optional(),
  field: CoverageFieldSchema,
  reason: CoverageGapReasonSchema,
});

export type CoverageGap = z.infer<typeof CoverageGapSchema>;

/**
 * `history_since` is the inclusive knowledge-time floor, present exactly when the substrate's
 * coverage record is active. While the record is preparing there is no floor to state, and a
 * placeholder would invent the moment history started.
 */
export const HistoryCoverageSchema = z.strictObject({
  contract_version: z.literal(COVERAGE_CONTRACT_VERSION),
  history_since: IsoTimestampSchema.optional(),
  status: z.enum(['supported', 'partial']),
  as_of: IsoTimestampSchema.optional(),
  knew_at: IsoTimestampSchema.optional(),
  limitations: z.array(CoverageLimitationSchema),
  gaps: z.array(CoverageGapSchema),
});

export type HistoryCoverage = z.infer<typeof HistoryCoverageSchema>;

/**
 * The four ways a request is refused rather than answered. A request outside the floor is
 * `before_horizon`; knowledge time past the request clock is `future_knowledge`; a coverage
 * record that cannot be read or does not say what it is is `coverage_store_unavailable`; a
 * record that changed under a read in flight is `coverage_changed`.
 *
 * The first two are settled before anything is spent. The other two can also arrive at the end
 * of a read that already did its work, and a refusal never says the work did not happen.
 *
 * A preparing record is not on this list. It is readable and it says what it is, so its
 * requests are answered as labeled partial results rather than refused.
 */
export const CoverageRefusalReasonSchema = z.enum([
  'before_horizon',
  'future_knowledge',
  'coverage_store_unavailable',
  'coverage_changed',
]);

export type CoverageRefusalReason = z.infer<typeof CoverageRefusalReasonSchema>;

/**
 * A refusal, not an empty answer. It carries what was asked and the bounds it was judged
 * against, so a caller can correct the request without a second round trip. `bounds` is empty
 * when the coverage record itself could not be read: nothing about the substrate's reach is
 * known at that moment.
 */
export const CoverageRefusalSchema = z.strictObject({
  contract_version: z.literal(COVERAGE_CONTRACT_VERSION),
  reason: CoverageRefusalReasonSchema,
  requested: z.strictObject({
    as_of: IsoTimestampSchema.optional(),
    knew_at: IsoTimestampSchema.optional(),
    /** The one clock the whole request was judged against, pinned at the entry point. */
    now: IsoTimestampSchema,
  }),
  bounds: z.strictObject({
    history_since: IsoTimestampSchema.optional(),
    coverage_state: z.enum(['preparing', 'active']).optional(),
  }),
});

export type CoverageRefusal = z.infer<typeof CoverageRefusalSchema>;

/**
 * The structured shape a command-line search prints under `--json`.
 *
 * This replaces the bare result array that shape currently emits, and the break is deliberate:
 * a coverage statement cannot be attached to an array, and dropping it would let a partial
 * answer print as a complete one. A consumer reading the old shape reads `results`, and
 * `schema_version` is how it tells the two apart.
 *
 * A refusal carries no results. The two coverage fields are mutually exclusive.
 */
export type CoverageEnvelope<T> = {
  readonly schema_version: 1;
  readonly results: readonly T[];
  readonly coverage?: HistoryCoverage;
  readonly coverage_refusal?: CoverageRefusal;
};

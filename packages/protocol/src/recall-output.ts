import { z } from 'zod';

import { CurrencySchema, IsoTimestampSchema, SupersededBySchema } from './common.js';

/**
 * Every method that can produce a recalled item: four seed strategies, hybrid-search
 * (vector, bm25, graph traversal), spreading activation, and context resonance. Fixed
 * rather than a plain string because the stages are a closed, specified set and every
 * consumer branches on this value.
 */
export const RecallMethodSchema = z.enum([
  'vector',
  'bm25',
  'graph_traversal',
  'activation',
  'resonance',
  'entity_resolution',
  'recency',
]);

export type RecallMethod = z.infer<typeof RecallMethodSchema>;

/**
 * Which method produced it, through which path, and with what activation score.
 * `path` is present for traversal- and activation-sourced items; direct hits from
 * vector and bm25 have none.
 */
export const RationaleSchema = z.strictObject({
  method: RecallMethodSchema,
  score: z.number(),
  path: z.string().min(1).optional(),
});

export type Rationale = z.infer<typeof RationaleSchema>;

/**
 * One recalled memory, shaped identically across every bucket. `currency` and
 * `superseded_by` carry lineage annotation on every item, not just facts. Default recall
 * is currency-aware, not currency-filtered, so any bucket may surface a superseded node.
 * `occurred_at` is the temporal context for episodes; other buckets omit it.
 *
 * `rank` and `confidence` are what let a reader compare two items. `rationale.score` cannot:
 * it is the producing method's own number, so a BM25 hit normalized to the best hit of its
 * cue prints 1.00 next to a cosine of 0.62 and the list reads as though the lexical hit were
 * the stronger one (the printed score measured as rising while the list went down, on 27% of
 * adjacent pairs).
 */
export const MemoryPackItemSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string().min(1),
  occurred_at: IsoTimestampSchema.optional(),
  /**
   * Position in the fused order across the whole pack, best first and counted from 1. Buckets
   * are a layout, not a ranking, so this is the only number that orders two items in
   * different buckets.
   */
  rank: z.number().int().positive(),
  /**
   * The absolute measurement admission read: the strongest cosine any method returned for the
   * item, on [0,1] and comparable between queries. Zero means the item was admitted on a
   * literal match (Lucene on the verbatim cue, or an exact entity name), which is evidence
   * rather than a measurement, so no number is invented for it.
   *
   * On a resonant item the cosine is measured in context space rather than against the query,
   * so it says how strongly the memory's neighborhood resembles the activated set and not how
   * well it answers what was asked. `rationale.method` is what tells the two apart, which is
   * why the rendered line prints the method beside the number.
   */
  confidence: z.number(),
  rationale: RationaleSchema,
  /**
   * The node's own stated reason, when it stored one (a Decision's `rationale` property
   * today). Optional and absent on most items, since most node types carry no such field.
   * Deliberately not named `rationale`: that name is `rationale` above, the retrieval
   * rationale (method, score, path), and the two answer different questions.
   */
  why: z.string().min(1).optional(),
  currency: CurrencySchema,
  superseded_by: SupersededBySchema.optional(),
});

export type MemoryPackItem = z.infer<typeof MemoryPackItemSchema>;

/**
 * A present bucket always has content. An empty category is omitted rather than sent as
 * an empty array. `.min(1)` makes that invariant part of the schema, not just a convention.
 */
const memoryPackBucket = z.array(MemoryPackItemSchema).min(1);

/**
 * Query cues weigh 3x; summary and recent turns 1x. The algorithm puts the summary at
 * 2x. Recall damps it because a summary cue competes with a query cue for a seed budget
 * that is always exactly full and never once improved the answer's rank.
 * `raw_query` and `raw_summary` are the degradation ladder's own sources. When the cue
 * model is down, recall proceeds on the caller's own text ("query and summary embeddings
 * plus BM25 over the raw query text"). Those cues have to be distinguishable from ones
 * the model extracted from the same material.
 */
export const CueSourceSchema = z.enum([
  'query',
  'summary',
  'recent_turns',
  'raw_query',
  'raw_summary',
]);

export type CueSource = z.infer<typeof CueSourceSchema>;

export const CueWeightSchema = z.union([z.literal(3), z.literal(2), z.literal(1)]);

export type CueWeight = z.infer<typeof CueWeightSchema>;

/**
 * What the caller is asking for, judged by the cue model rather than read off the words. One
 * member, because a decision-shaped query is the only intent with a measured ranking
 * failure: on an entirely decision-oriented workload the bucket meant to answer "what did
 * we decide" gave Decision nodes 3% of its slots. A second intent is an addition here,
 * not a redesign.
 */
export const CueIntentSchema = z.enum(['decision']);

export type CueIntent = z.infer<typeof CueIntentSchema>;

export const CueSchema = z.strictObject({
  text: z.string().min(1),
  source: CueSourceSchema,
  weight: CueWeightSchema,
  /** Absent when the model judged no intent, and on the degraded path, where no model ran. */
  intent: CueIntentSchema.optional(),
});

export type Cue = z.infer<typeof CueSchema>;

/**
 * The recall stages, each timed independently. `resonance` is the second pass and is optional
 * for one reason only: a pack is persisted to `last_pack` and read back later, so packs written
 * before the stage existed have to keep parsing. Recall always times it, including on the runs
 * where it declines to search, so a pack this version produces always carries the field and a
 * near-zero reading is the stage saying it had nothing to resonate from.
 */
export const StageTimingsMsSchema = z.strictObject({
  embed: z.number().nonnegative(),
  cues: z.number().nonnegative(),
  seeds: z.number().nonnegative(),
  activation: z.number().nonnegative(),
  fusion: z.number().nonnegative(),
  resonance: z.number().nonnegative().optional(),
});

export type StageTimingsMs = z.infer<typeof StageTimingsMsSchema>;

/**
 * Recall has three legs that can drop out without failing the call: the cue model,
 * the embedding call, and the graph. A consumer cannot tell any of them from the items
 * alone because a pack thinned by an outage reads exactly like a pack thinned by a
 * query nothing matches. Each rung that fired names itself here. The field stays absent
 * on a normal run.
 *
 * `timeout`, `model_error`, and `invalid_output` are the inference stages' reasons.
 * `unavailable` is the graph's reason and means no seed strategy could reach it.
 */
export const DegradationSchema = z.strictObject({
  stage: z.enum(['cues', 'embed', 'graph']),
  reason: z.enum(['timeout', 'model_error', 'invalid_output', 'unavailable']),
});

export type Degradation = z.infer<typeof DegradationSchema>;

/**
 * Why the pack is smaller than the substrate could have answered with. `activation_budget`
 * means spreading activation stopped on its visit budget rather than converging, so the
 * traversal leg was cut off mid-spread, measured on 60.2% of recalls against a
 * populated substrate, logged and never told to the caller.
 */
export const PackTruncationSchema = z.enum(['activation_budget']);

export type PackTruncation = z.infer<typeof PackTruncationSchema>;

/**
 * What the admission gate judged and what it refused. Without this a thin pack is unreadable:
 * `considered: 0` is a substrate with nothing in it, `considered: 43` with everything dropped
 * is a floor doing its job, and the two need opposite responses from the caller. The floors
 * themselves are reported alongside the counts because a drop count means nothing without the
 * bar it was measured against.
 */
export const AdmissionReportSchema = z.strictObject({
  /** Distinct candidates the gate judged; contentless and structural rows never reach it. */
  considered: z.number().int().nonnegative(),
  /** Cleared the gate. More than the pack holds means the caps or the token budget cut the rest. */
  admitted: z.number().int().nonnegative(),
  /** Measured by at least one method, and no measurement, exact hit or corroboration cleared. */
  dropped_below_floor: z.number().int().nonnegative(),
  /** No method measured it against the query: a recency or plain-BM25 seed, or a pending vector. */
  dropped_unmeasured: z.number().int().nonnegative(),
  /**
   * The part of `dropped_unmeasured` no seed leg found: reached by spreading activation and
   * never scored. A caller watching whether traversal contributes anything reads this one,
   * since the whole tally is mostly the two legs that measure nothing by construction.
   */
  dropped_unmeasured_arrival: z.number().int().nonnegative(),
  dropped_duplicate_content: z.number().int().nonnegative(),
  /** Admitted, then bumped from a near-identical cluster that had already filled its cap. */
  dropped_near_duplicate: z.number().int().nonnegative(),
  /** Cosine at or above which one measurement admits an item on its own. */
  vector_floor: z.number(),
  /** Cosine at or above which a measurement counts as one unit of corroboration. */
  corroboration_floor: z.number(),
  bm25_mode: z.enum(['exact', 'corroborated', 'any']),
});

export type AdmissionReportOutput = z.infer<typeof AdmissionReportSchema>;

/**
 * A list, because the rungs are independent: a full Ollama outage takes the cue and embed
 * legs together, and reporting only the worse of the two understates how thin the answer
 * is. Present means at least one rung fired.
 */
export const MemoryPackMetadataSchema = z.strictObject({
  token_estimate: z.number().int().nonnegative(),
  stage_timings_ms: StageTimingsMsSchema,
  cues: z.array(CueSchema),
  admission: AdmissionReportSchema,
  degraded: z.array(DegradationSchema).min(1).optional(),
  /**
   * The calling session's own episodes with no orchestrator ledger key. Real, stored, and
   * reachable by raw text, but not yet reachable by entity resolution, traversal, or context
   * vectors (a memory was not fully recallable for 20 to 25 minutes and the pack never
   * said so). Optional and omitted at zero: a healthy pack states nothing extra.
   */
  pending_enrichment: z.number().int().positive().optional(),
  /** Absent on a spread that converged; present means the pack is a cut-off answer. */
  truncated: PackTruncationSchema.optional(),
});

export type MemoryPackMetadata = z.infer<typeof MemoryPackMetadataSchema>;

/**
 * Every bucket is optional and, when present, non-empty (empty categories are omitted).
 * `rendered_text` is the text block dropped straight into agent reasoning. `metadata`
 * is never omitted, even for an explicitly empty pack.
 *
 * The omission is deliberate and stays: a caller reading the raw JSON sees only what was
 * served, not five keys where three are `[]`. That is the wrong shape for a typed consumer
 * that reduces or counts across buckets, since "absent" and "empty" would otherwise both have
 * to be handled at every call site. Such a consumer reads a pack through `packBuckets` below,
 * which is where that handling belongs once, rather than changing what goes over the wire.
 */
export const MemoryPackSchema = z.strictObject({
  facts: memoryPackBucket.optional(),
  episodes: memoryPackBucket.optional(),
  narratives: memoryPackBucket.optional(),
  preferences: memoryPackBucket.optional(),
  resonant: memoryPackBucket.optional(),
  rendered_text: z.string(),
  metadata: MemoryPackMetadataSchema,
});

export type MemoryPack = z.infer<typeof MemoryPackSchema>;

/** `MemoryPackSchema`'s bucket keys, in schema and render order. */
export const MEMORY_PACK_BUCKETS = [
  'facts',
  'episodes',
  'narratives',
  'preferences',
  'resonant',
] as const satisfies readonly (keyof typeof MemoryPackSchema.shape)[];

export type MemoryPackBucket = (typeof MEMORY_PACK_BUCKETS)[number];

/**
 * Every bucket as a (possibly empty) array, one stable shape a typed consumer can index
 * without an `undefined` check at every site. Reads the wire pack; does not change it.
 */
export function packBuckets(
  pack: MemoryPack,
): Readonly<Record<MemoryPackBucket, readonly MemoryPackItem[]>> {
  return {
    facts: pack.facts ?? [],
    episodes: pack.episodes ?? [],
    narratives: pack.narratives ?? [],
    preferences: pack.preferences ?? [],
    resonant: pack.resonant ?? [],
  };
}

/** The `recall` tool's output is the MemoryPack itself. */
export const RecallOutputSchema = MemoryPackSchema;

export type RecallOutput = MemoryPack;

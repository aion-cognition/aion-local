import { z } from 'zod';
import { CurrencySchema, IsoTimestampSchema, SupersededBySchema } from './common.js';

/**
 * Every method that can produce a recalled item: whitepaper §5.2's four seed strategies,
 * §5.3's hybrid-search vector/bm25/graph_traversal trio, §5.4's spreading activation, and
 * §5.6's context resonance. Fixed rather than a plain string because P2's stages are a
 * closed, spec'd set (whitepaper §5) and every consumer branches on this value.
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
 * Whitepaper §5.7: "which method produced it, through which path, with what activation
 * score." `path` is present for traversal- and activation-sourced items; direct hits from
 * vector/bm25 have none.
 */
export const RationaleSchema = z.strictObject({
  method: RecallMethodSchema,
  score: z.number(),
  path: z.string().min(1).optional(),
});

export type Rationale = z.infer<typeof RationaleSchema>;

/**
 * One recalled memory, shaped identically across every bucket. `currency`/`superseded_by`
 * carry PRD §5.5's lineage annotation on every item, not just facts: default recall is
 * currency-aware, not currency-filtered, so any bucket may surface a superseded node.
 * `occurred_at` is whitepaper §5.7's "temporal context" for episodes; other buckets omit it.
 */
export const MemoryPackItemSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string().min(1),
  occurred_at: IsoTimestampSchema.optional(),
  rationale: RationaleSchema,
  currency: CurrencySchema,
  superseded_by: SupersededBySchema.optional(),
});

export type MemoryPackItem = z.infer<typeof MemoryPackItemSchema>;

/**
 * A present bucket always has content; an empty category is omitted rather than sent as
 * `[]` (PRD §3.1, whitepaper §5.7). `.min(1)` makes that invariant part of the schema, not
 * just a convention P2 has to remember.
 */
const memoryPackBucket = z.array(MemoryPackItemSchema).min(1);

/**
 * PRD §6.1 / whitepaper Algorithm 1: query cues weigh 3x, summary 2x, recent turns 1x.
 * `raw_query` and `raw_summary` are the degradation ladder's own sources — when the cue
 * model is down, recall proceeds on the caller's own text ("query and summary embeddings
 * plus BM25 over the raw query text"), and those cues have to be distinguishable from ones
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

export const CueSchema = z.strictObject({
  text: z.string().min(1),
  source: CueSourceSchema,
  weight: CueWeightSchema,
});

export type Cue = z.infer<typeof CueSchema>;

/** The five recall stages, each timed independently. */
export const StageTimingsMsSchema = z.strictObject({
  embed: z.number().nonnegative(),
  cues: z.number().nonnegative(),
  seeds: z.number().nonnegative(),
  activation: z.number().nonnegative(),
  fusion: z.number().nonnegative(),
});

export type StageTimingsMs = z.infer<typeof StageTimingsMsSchema>;

/**
 * PRD §6.1: when the cue model fails or busts its budget, recall answers from raw-query
 * embedding plus BM25 instead. A consumer cannot tell that from the items alone — a
 * degraded pack looks like a thin one — so the ladder names itself here and stays absent
 * on a normal run.
 */
export const DegradationSchema = z.strictObject({
  stage: z.literal('cues'),
  reason: z.enum(['timeout', 'model_error', 'invalid_output']),
});

export type Degradation = z.infer<typeof DegradationSchema>;

export const MemoryPackMetadataSchema = z.strictObject({
  token_estimate: z.number().int().nonnegative(),
  stage_timings_ms: StageTimingsMsSchema,
  cues: z.array(CueSchema),
  degraded: DegradationSchema.optional(),
});

export type MemoryPackMetadata = z.infer<typeof MemoryPackMetadataSchema>;

/**
 * Whitepaper §5.7. Every bucket is optional and, when present, non-empty (PRD §3.1's
 * empty-category omission). `rendered_text` is the text block dropped straight into agent
 * reasoning; `metadata` is never omitted, even for an explicitly empty pack.
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

/** The `recall` tool's output is the MemoryPack itself (PRD §3.1). */
export const RecallOutputSchema = MemoryPackSchema;

export type RecallOutput = MemoryPack;

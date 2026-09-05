/**
 * The pack's taxonomy: which bucket a memory answers in, the order the buckets render in, and
 * the caps they hold. Kept apart from assembly because it is a table and a lookup, and
 * assembly is a budget.
 */

export type PackBucket =
  'facts' | 'episodes' | 'narratives' | 'intentions' | 'preferences' | 'resonant';

/** Schema order, which is also render order. */
export const PACK_BUCKETS: readonly PackBucket[] = [
  'facts',
  'episodes',
  'narratives',
  'intentions',
  'preferences',
  'resonant',
];

export type BucketCaps = Readonly<Record<PackBucket, number>>;

/**
 * Which bucket a node type answers in. Entity-derived content answers in facts and
 * conversational memory in episodes; `Member` and `Workspace` carry the companion `Entity`
 * label, so the backbone resolves through the same row.
 *
 * The nine cognitive types answer in facts alongside entities. "The API redesign was decided
 * in Sprint 12" is a fact, and a Decision node carries it rather than an entity, so the
 * interpretive layer belongs where a reader looks for what is known rather than for what was
 * said. Leaving them unrouted would be worse than a taxonomy quibble: they carry content
 * vectors and sit in `content_fts`, so retrieval finds them and assembly would then drop
 * every one.
 *
 * A Bridge answers in facts for the same reason. It names two neighbourhoods nothing else
 * connects, which is a fact about the substrate, and it carries a summary and a content vector
 * of its own, so the vector leg returns it.
 *
 * Preferences still have no producer, since preference extraction is unbuilt, so that bucket is
 * structurally absent from a pack rather than empty. A label with no bucket cannot be packed and
 * its item is dropped.
 *
 * The resonant and intentions buckets are not in this table and never will be. Every other
 * bucket answers "what kind of memory is this", which a label decides; those two answer "how was
 * this found", which only the stage that found it knows. A resonant Episode belongs beside the
 * other resonant discoveries, not beside the episodes the query matched directly, and a Goal a
 * trigger brought back belongs beside the other standing intentions rather than among the facts
 * the query asked for. A Goal the search itself found is routed by this table, to facts, because
 * the query is what put it there.
 */
const BUCKET_BY_LABEL: Readonly<Record<string, PackBucket>> = {
  Episode: 'episodes',
  Turn: 'episodes',
  Entity: 'facts',
  Bridge: 'facts',
  Narrative: 'narratives',
  Goal: 'facts',
  Plan: 'facts',
  Decision: 'facts',
  Insight: 'facts',
  Concept: 'facts',
  Context: 'facts',
  Event: 'facts',
  Pattern: 'facts',
  Trend: 'facts',
};

export const BUCKET_HEADINGS: Readonly<Record<PackBucket, string>> = {
  facts: '## Facts',
  episodes: '## Episodes',
  narratives: '## Narratives',
  intentions: '## Intentions',
  preferences: '## Preferences',
  resonant: '## Resonant',
};

export function bucketFor(labels: readonly string[]): PackBucket | undefined {
  for (const label of labels) {
    const bucket = BUCKET_BY_LABEL[label];
    if (bucket !== undefined) {
      return bucket;
    }
  }
  return undefined;
}

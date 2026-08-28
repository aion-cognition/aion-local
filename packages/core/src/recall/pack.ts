import {
  MemoryPackSchema,
  type Cue,
  type Degradation,
  type MemoryPack,
  type MemoryPackItem,
  type StageTimingsMs,
} from '@aion/protocol';
import type { FusedItem } from './fusion.js';

/**
 * Whitepaper §5.7. The ranked candidate set becomes the MemoryPack: routed to buckets,
 * capped per bucket, cut to the token budget, and rendered into the text block the agent
 * drops straight into its reasoning. Empty categories are omitted and an empty pack says
 * so plainly (PRD §3.1) rather than padding itself with what the floor already rejected.
 */

export type PackBucket = 'facts' | 'episodes' | 'narratives' | 'preferences' | 'resonant';

/** Schema order, which is also render order. */
export const PACK_BUCKETS: readonly PackBucket[] = [
  'facts',
  'episodes',
  'narratives',
  'preferences',
  'resonant',
];

export type BucketCaps = Readonly<Record<PackBucket, number>>;

/**
 * Which bucket a node type answers in. Whitepaper §5.7 puts Entity-derived content in
 * facts and conversational memory in episodes; `Member` and `Workspace` carry the
 * companion `Entity` label, so the backbone resolves through the same row.
 *
 * Narratives, preferences, and the resonant bucket have no producer yet — narratives and
 * preferences arrive with P3's reflection pipeline, resonance with P4's context vectors —
 * so those buckets are structurally absent from a P2 pack rather than empty. A label with
 * no bucket cannot be packed and its item is dropped.
 */
const BUCKET_BY_LABEL: Readonly<Record<string, PackBucket>> = {
  Episode: 'episodes',
  Turn: 'episodes',
  Entity: 'facts',
};

/**
 * The episodes cap counts episodes, so a `Turn` folds into the episode it came from. P1 writes
 * one content-bearing, separately indexed Turn per turn, which makes a five-turn episode able
 * to fill the whole bucket by itself and crowd out every other episode. Whichever of the two
 * ranked higher represents that episode; the loser is skipped rather than packed, since an
 * Episode's text is the render of its own turns and packing both says the same thing twice.
 */
function episodeKey(item: FusedItem): string {
  return item.sourceEpisodeId ?? item.id;
}

/**
 * Tokens per character for the budget estimate. Four is the long-standing rule of thumb for
 * English text under BPE vocabularies and it is deliberately crude: the budget is a cap on
 * what recall hands back, and a real tokenizer on the recall path would be both a
 * dependency on the agent's model and text machinery this build keeps out (PRD §2).
 */
export const CHARS_PER_TOKEN = 4;

const PACK_HEADING = '# Memory';

const EMPTY_PACK_TEXT = `${PACK_HEADING}\n\nNo memories matched this query.`;

const BUCKET_HEADINGS: Readonly<Record<PackBucket, string>> = {
  facts: '## Facts',
  episodes: '## Episodes',
  narratives: '## Narratives',
  preferences: '## Preferences',
  resonant: '## Resonant',
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function bucketFor(labels: readonly string[]): PackBucket | undefined {
  for (const label of labels) {
    const bucket = BUCKET_BY_LABEL[label];
    if (bucket !== undefined) {
      return bucket;
    }
  }
  return undefined;
}

function toPackItem(item: FusedItem): MemoryPackItem {
  return {
    id: item.id,
    content: item.content,
    ...(item.occurredAt === undefined ? {} : { occurred_at: item.occurredAt.toISOString() }),
    rationale: item.rationale,
    currency: item.currency,
    ...(item.supersededBy === undefined
      ? {}
      : {
          superseded_by: {
            id: item.supersededBy.id,
            at: item.supersededBy.at.toISOString(),
          },
        }),
  };
}

/**
 * Content on its own line, then one line of provenance: id, method and score, the path for
 * an activated item, and the lineage marker for a superseded one. PRD §5.5 requires the
 * marker wherever superseded knowledge surfaces, so it is part of the rendered block and
 * not only of the structured item.
 */
function renderItem(item: MemoryPackItem, position: number): string {
  const facts = [
    `[${item.id}]`,
    `${item.rationale.method} ${item.rationale.score.toFixed(2)}`,
  ];
  if (item.occurred_at !== undefined) {
    facts.push(`occurred ${item.occurred_at}`);
  }
  if (item.rationale.path !== undefined) {
    facts.push(`path ${item.rationale.path}`);
  }
  if (item.superseded_by !== undefined) {
    facts.push(`superseded by ${item.superseded_by.id} at ${item.superseded_by.at}`);
  }
  return `${String(position)}. ${item.content}\n   ${facts.join(' | ')}`;
}

function renderBucket(bucket: PackBucket, items: readonly MemoryPackItem[]): string {
  const blocks = items.map((item, index) => renderItem(item, index + 1));
  return `${BUCKET_HEADINGS[bucket]}\n${blocks.join('\n')}`;
}

export type AssemblePackInput = {
  /** Fused and ranked, best first. Bucket routing, caps, and the budget are applied here. */
  readonly items: readonly FusedItem[];
  readonly caps: BucketCaps;
  readonly tokenBudget: number;
  readonly cues: readonly Cue[];
  readonly timings: StageTimingsMs;
  /** Present when the cue ladder ran (PRD §6.1); absent on a normal recall. */
  readonly degraded?: Degradation;
};

type Selection = Map<PackBucket, MemoryPackItem[]>;

/**
 * Rank order decides everything; the caps and the budget only decide where it stops. An
 * item that would bust the budget is skipped rather than ending assembly, so one oversized
 * memory cannot starve every smaller one ranked under it.
 *
 * The running estimate charges a bucket's heading to its first accepted item, because the
 * heading is text the agent pays for too.
 */
function select(input: AssemblePackInput): Selection {
  const selection: Selection = new Map();
  const packedEpisodes = new Set<string>();
  let tokens = estimateTokens(PACK_HEADING);

  for (const item of input.items) {
    const bucket = bucketFor(item.labels);
    if (bucket === undefined) {
      continue;
    }

    const held = selection.get(bucket) ?? [];
    if (held.length >= input.caps[bucket]) {
      continue;
    }
    const key = bucket === 'episodes' ? episodeKey(item) : undefined;
    if (key !== undefined && packedEpisodes.has(key)) {
      continue;
    }

    const packItem = toPackItem(item);
    const cost =
      estimateTokens(renderItem(packItem, held.length + 1)) +
      (held.length === 0 ? estimateTokens(BUCKET_HEADINGS[bucket]) : 0);
    if (tokens + cost > input.tokenBudget) {
      continue;
    }

    tokens += cost;
    held.push(packItem);
    selection.set(bucket, held);
    if (key !== undefined) {
      packedEpisodes.add(key);
    }
  }

  return selection;
}

function render(selection: Selection): string {
  const sections: string[] = [];
  for (const bucket of PACK_BUCKETS) {
    const items = selection.get(bucket);
    if (items === undefined || items.length === 0) {
      continue;
    }
    sections.push(renderBucket(bucket, items));
  }
  if (sections.length === 0) {
    return EMPTY_PACK_TEXT;
  }
  return `${PACK_HEADING}\n\n${sections.join('\n\n')}`;
}

/**
 * The pack is parsed against its own schema on the way out. Its invariants — a present
 * bucket is never empty, an item always carries content and a rationale — are this
 * module's to hold, so a violation is a defect here and failing loudly beats handing an
 * agent a pack the protocol does not describe.
 */
export function assemblePack(input: AssemblePackInput): MemoryPack {
  const selection = select(input);
  const renderedText = render(selection);

  const buckets: Record<string, readonly MemoryPackItem[]> = {};
  for (const bucket of PACK_BUCKETS) {
    const items = selection.get(bucket);
    if (items !== undefined && items.length > 0) {
      buckets[bucket] = items;
    }
  }

  return MemoryPackSchema.parse({
    ...buckets,
    rendered_text: renderedText,
    metadata: {
      token_estimate: estimateTokens(renderedText),
      stage_timings_ms: input.timings,
      cues: [...input.cues],
      ...(input.degraded === undefined ? {} : { degraded: input.degraded }),
    },
  });
}

import {
  MemoryPackSchema,
  type AdmissionReportOutput,
  type Cue,
  type Degradation,
  type MemoryPack,
  type MemoryPackItem,
  type PackTruncation,
  type StageTimingsMs,
} from '@aion/protocol';
import type { AdmissionReport } from './admission.js';
import { GLOSS_LABEL } from './facts.js';
import type { FusedItem } from './fusion.js';

/**
 * The ranked candidate set becomes the MemoryPack: routed to buckets, capped per bucket, cut
 * to the token budget, and rendered into the text block the agent drops straight into its
 * reasoning. Empty categories are omitted and an empty pack says so plainly rather than
 * padding itself with what the floors already rejected.
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
 * Preferences and the resonant bucket still have no producer, since preference extraction is
 * unbuilt and resonance is not yet implemented, so those two are structurally absent from a
 * pack rather than empty. A label with no bucket cannot be packed and its item is dropped.
 */
const BUCKET_BY_LABEL: Readonly<Record<string, PackBucket>> = {
  Episode: 'episodes',
  Turn: 'episodes',
  Entity: 'facts',
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

/**
 * The episodes cap counts episodes, so a `Turn` folds into the episode it came from. Capture
 * writes one content-bearing, separately indexed Turn per turn, which makes a five-turn
 * episode able to fill the whole bucket alone and crowd out every other episode. Whichever of
 * the two ranked higher represents that episode; the loser is skipped rather than packed,
 * since an Episode's text is the render of its own turns and packing both says it twice.
 */
function episodeKey(item: FusedItem): string {
  return item.sourceEpisodeId ?? item.id;
}

/**
 * Tokens per character for the budget estimate. Four is the long-standing rule of thumb for
 * English text under BPE vocabularies and it is deliberately crude: the budget is a cap on
 * what recall hands back, and a real tokenizer on the recall path would be both a dependency
 * on the agent's model and text machinery the cognitive path keeps out.
 */
export const CHARS_PER_TOKEN = 4;

const PACK_HEADING = '# Memory';

const EMPTY_PACK_BODY = 'No memories matched this query.';

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

/**
 * An item plus the one thing the wire item cannot carry: whether it is an entity gloss.
 * Labels are graph vocabulary and stay out of the protocol, but the gloss cap counts them
 * and the provenance-age annotation only applies to them.
 */
type PackEntry = {
  readonly item: MemoryPackItem;
  readonly gloss: boolean;
};

function toPackItem(item: FusedItem, rank: number): MemoryPackItem {
  return {
    id: item.id,
    content: item.content,
    ...(item.occurredAt === undefined ? {} : { occurred_at: item.occurredAt.toISOString() }),
    rank,
    // `measured`, not `relevance`: relevance is the producing method's own number, and the
    // BM25 leg normalizes to the best hit of its cue, so the top lexical hit of any query
    // would print 1.00 beside a cosine of 0.62.
    confidence: item.measured,
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

/** Calendar day only: the age is the point, and a timestamp to the millisecond hides it. */
function renderDay(timestamp: string): string {
  return timestamp.slice(0, 'YYYY-MM-DD'.length);
}

/**
 * Content on its own line, then one line of provenance: id, the method that found it, the
 * absolute confidence behind admission, the path for an activated item, and the lineage
 * marker for a superseded one. The marker belongs wherever superseded knowledge surfaces, so
 * it is part of the rendered block and not only of the structured item.
 *
 * The list number is the item's rank across the whole pack rather than its position in its
 * own bucket, so the reader can order two items in different buckets. `rationale.score` is
 * deliberately not printed: it is the producing method's own number and comparing two of
 * them says nothing.
 *
 * An entity gloss is annotated with the date of its first mention. The description was
 * written once, by the episode that first named the entity, and is never revised, so
 * rendering it without its age serves a year-old sentence as a current fact.
 */
function renderItem(entry: PackEntry): string {
  const { item } = entry;
  // Zero is not low confidence, it is no measurement: the item was admitted on a literal
  // match, and printing "confidence 0.00" beside a memory that answered exactly would read
  // as the opposite of what the gate decided.
  const measurement =
    item.confidence === 0 ? 'exact match' : `confidence ${item.confidence.toFixed(2)}`;
  const facts = [`[${item.id}]`, item.rationale.method, measurement];
  if (item.occurred_at !== undefined) {
    facts.push(
      entry.gloss
        ? `from first mention, ${renderDay(item.occurred_at)}`
        : `occurred ${item.occurred_at}`,
    );
  }
  if (item.rationale.path !== undefined) {
    facts.push(`path ${item.rationale.path}`);
  }
  if (item.superseded_by !== undefined) {
    facts.push(`superseded by ${item.superseded_by.id} at ${item.superseded_by.at}`);
  }
  return `${String(item.rank)}. ${item.content}\n   ${facts.join(' | ')}`;
}

function renderBucket(bucket: PackBucket, entries: readonly PackEntry[]): string {
  const blocks = entries.map((entry) => renderItem(entry));
  return `${BUCKET_HEADINGS[bucket]}\n${blocks.join('\n')}`;
}

export type AssemblePackInput = {
  /** Fused and ranked, best first. Bucket routing, caps, and the budget are applied here. */
  readonly items: readonly FusedItem[];
  /** What the floors judged and refused, so a thin pack can say which of the two it is. */
  readonly admission: AdmissionReport;
  readonly caps: BucketCaps;
  readonly tokenBudget: number;
  readonly cues: readonly Cue[];
  readonly timings: StageTimingsMs;
  /** Every rung of the degradation ladder that fired; absent on a normal recall. */
  readonly degraded?: readonly Degradation[];
  /** The calling session's own episodes with no orchestrator ledger key yet. */
  readonly pendingEnrichment?: number;
  /** Set when spreading activation stopped on its budget rather than converging. */
  readonly truncated?: PackTruncation;
  /**
   * Goal and Plan nodes whose text is the query said back (`facts.ts`). Kept out of facts
   * entirely rather than ranked down: a restatement carries no answer at any rank, and it is
   * maximally similar to the query, so ranking alone puts it first.
   */
  readonly restating?: ReadonlySet<string>;
  /**
   * How many entity glosses the facts bucket may hold. Absent leaves it uncapped; the
   * pipeline always supplies it, because uncapped is what the exercise measured at 58% of slots.
   */
  readonly entityGlossCap?: number;
};

type Selection = Map<PackBucket, PackEntry[]>;

const STAGE_PHRASES: Readonly<Record<Degradation['stage'], string>> = {
  cues: 'cue extraction',
  embed: 'embedding',
  graph: 'graph reads',
};

const TRUNCATION_PHRASES: Readonly<Record<PackTruncation, string>> = {
  activation_budget: 'spread truncated on the activation budget',
};

/**
 * The honesty signals as one plain line at the top of the rendered block. A client reading
 * only `content` from an MCP tool result sees the rendered text and nothing else, so a pack
 * whose metadata says "degraded" reads to that client exactly like a confident answer — one
 * exercise angle lost a full baseline run to precisely that. The same three signals
 * stay in `metadata` for a structured consumer; this is the copy that reaches everyone.
 */
function honestyNote(input: AssemblePackInput): string | undefined {
  const clauses: string[] = [];
  for (const rung of input.degraded ?? []) {
    clauses.push(`degraded ${STAGE_PHRASES[rung.stage]} (${rung.reason})`);
  }
  if (input.truncated !== undefined) {
    clauses.push(TRUNCATION_PHRASES[input.truncated]);
  }
  const pending = input.pendingEnrichment ?? 0;
  if (pending > 0) {
    clauses.push(
      `${String(pending)} recent episode${pending === 1 ? '' : 's'} not yet enriched`,
    );
  }
  if (clauses.length === 0) {
    return undefined;
  }
  return `note: ${clauses.join('; ')}`;
}

/**
 * Rank order decides everything; the caps and the budget only decide where it stops. An
 * item that would bust the budget is skipped rather than ending assembly, so one oversized
 * memory cannot starve every smaller one ranked under it.
 *
 * The running estimate charges a bucket's heading to its first accepted item, because the
 * heading is text the agent pays for too.
 */
function select(input: AssemblePackInput, note: string | undefined): Selection {
  const selection: Selection = new Map();
  const packedEpisodes = new Set<string>();
  // The note is charged with its own blank-line separator: it is text the agent pays for, and
  // a caller that asked for a small budget should not lose an item to it silently.
  let tokens =
    estimateTokens(PACK_HEADING) + (note === undefined ? 0 : estimateTokens(`${note}\n\n`));
  let ranked = 0;
  let glosses = 0;

  for (const item of input.items) {
    const bucket = bucketFor(item.labels);
    if (bucket === undefined) {
      continue;
    }
    if (bucket === 'facts' && input.restating?.has(item.id) === true) {
      continue;
    }

    const gloss = bucket === 'facts' && item.labels.includes(GLOSS_LABEL);
    if (gloss && glosses >= (input.entityGlossCap ?? Number.POSITIVE_INFINITY)) {
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

    const entry: PackEntry = { item: toPackItem(item, ranked + 1), gloss };
    const cost =
      estimateTokens(renderItem(entry)) +
      (held.length === 0 ? estimateTokens(BUCKET_HEADINGS[bucket]) : 0);
    if (tokens + cost > input.tokenBudget) {
      continue;
    }

    tokens += cost;
    ranked += 1;
    if (gloss) {
      glosses += 1;
    }
    held.push(entry);
    selection.set(bucket, held);
    if (key !== undefined) {
      packedEpisodes.add(key);
    }
  }

  return selection;
}

function render(selection: Selection, note: string | undefined): string {
  const sections: string[] = [];
  if (note !== undefined) {
    sections.push(note);
  }
  for (const bucket of PACK_BUCKETS) {
    const entries = selection.get(bucket);
    if (entries === undefined || entries.length === 0) {
      continue;
    }
    sections.push(renderBucket(bucket, entries));
  }
  if (sections.length === (note === undefined ? 0 : 1)) {
    sections.push(EMPTY_PACK_BODY);
  }
  return `${PACK_HEADING}\n\n${sections.join('\n\n')}`;
}

/** Snake_case on the wire, and the policy flattened alongside the counts it explains. */
function toAdmissionOutput(report: AdmissionReport): AdmissionReportOutput {
  return {
    considered: report.considered,
    admitted: report.admitted,
    dropped_below_floor: report.droppedBelowFloor,
    dropped_unmeasured: report.droppedUnmeasured,
    dropped_duplicate_content: report.droppedDuplicateContent,
    dropped_near_duplicate: report.droppedNearDuplicate,
    vector_floor: report.policy.vectorFloor,
    corroboration_floor: report.policy.corroborationFloor,
    bm25_mode: report.policy.bm25Mode,
  };
}

/**
 * The pack is parsed against its own schema on the way out. Its invariants (a present bucket
 * is never empty, an item always carries content and a rationale) are this module's to hold,
 * so a violation is a defect here and failing loudly beats handing an agent a pack the
 * protocol does not describe.
 */
export function assemblePack(input: AssemblePackInput): MemoryPack {
  const note = honestyNote(input);
  const selection = select(input, note);
  const renderedText = render(selection, note);

  const buckets: Record<string, readonly MemoryPackItem[]> = {};
  for (const bucket of PACK_BUCKETS) {
    const entries = selection.get(bucket);
    if (entries !== undefined && entries.length > 0) {
      buckets[bucket] = entries.map((entry) => entry.item);
    }
  }

  return MemoryPackSchema.parse({
    ...buckets,
    rendered_text: renderedText,
    metadata: {
      token_estimate: estimateTokens(renderedText),
      stage_timings_ms: input.timings,
      cues: [...input.cues],
      admission: toAdmissionOutput(input.admission),
      ...(input.degraded === undefined || input.degraded.length === 0
        ? {}
        : { degraded: [...input.degraded] }),
      ...(input.pendingEnrichment === undefined || input.pendingEnrichment === 0
        ? {}
        : { pending_enrichment: input.pendingEnrichment }),
      ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
    },
  });
}

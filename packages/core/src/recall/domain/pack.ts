import {
  MemoryPackSchema,
  type AdmissionReportOutput,
  type Cue,
  type Degradation,
  type MemoryPack,
  type MemoryPackItem,
  type PackTruncation,
  type RelatedClaim,
  type StageTimingsMs,
} from '@aion/protocol';

import type { AdmissionReport } from './admission.js';
import { GLOSS_LABEL } from './facts.js';
import type { FusedItem } from './fusion.js';
import {
  BUCKET_HEADINGS,
  PACK_BUCKETS,
  bucketFor,
  type BucketCaps,
  type PackBucket,
} from './pack-buckets.js';
import { renderBucket, renderItem, toPackItem, type PackEntry } from './pack-item.js';
import { hashContent } from '../../reflection/domain/content.js';

/**
 * The ranked candidate set becomes the MemoryPack: routed to buckets, capped per bucket, cut
 * to the token budget, and rendered into the text block the agent drops straight into its
 * reasoning. Empty categories are omitted and an empty pack says so plainly rather than
 * padding itself with what the floors already rejected.
 */

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

/**
 * The three other ways a pack empties, all of them the wire cutting matches the substrate did
 * hold. Saying "no memories matched" for any of them would be false, and it is the one sentence
 * a reader would act on by asking again.
 */
const EMPTY_AFTER_REPEATS_BODY = 'This session already holds every memory this query matched.';

const EMPTY_AFTER_OWN_BODY = "Every memory this query matched came from this session's own record.";

const EMPTY_AFTER_BOTH_BODY =
  'This session already holds every memory this query matched, from earlier recalls and from ' +
  'its own record.';

function emptyOpening(repeats: number, own: number): string {
  if (repeats > 0 && own > 0) {
    return EMPTY_AFTER_BOTH_BODY;
  }
  if (own > 0) {
    return EMPTY_AFTER_OWN_BODY;
  }
  if (repeats > 0) {
    return EMPTY_AFTER_REPEATS_BODY;
  }
  return EMPTY_PACK_BODY;
}

/**
 * What an empty pack says about itself, in the rendered text rather than only in metadata.
 *
 * The sentence alone reads the same for three states that call for three different responses:
 * a substrate with nothing in it, a floor that judged real candidates and refused all of them,
 * and a set of candidates nothing could measure at all. The counts are in metadata already;
 * this is the copy that reaches a client reading only the rendered block, which is also the
 * client most likely to read a note about a truncated spread as the reason the pack is empty.
 */
function emptyPackBody(report: AdmissionReport, repeats: number, own: number): string {
  const opening = emptyOpening(repeats, own);
  if (report.considered === 0) {
    return `${opening} Nothing reached the admission gate.`;
  }

  const clauses: string[] = [];
  if (report.droppedBelowFloor > 0) {
    clauses.push(
      `${String(report.droppedBelowFloor)} measured under the ${report.policy.vectorFloor.toFixed(2)} floor`,
    );
  }
  if (report.droppedUnmeasured > 0) {
    clauses.push(`${String(report.droppedUnmeasured)} that nothing measured against it`);
  }
  if (clauses.length === 0) {
    return opening;
  }
  return `${opening} Of ${String(report.considered)} candidates: ${clauses.join(', ')}.`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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
   * pipeline always supplies it, because uncapped measured 58% of the bucket's slots.
   */
  readonly entityGlossCap?: number;
  /**
   * Context resonance's discoveries, best first by context similarity. They are routed to the
   * resonant bucket by where they came from rather than by their labels, and they are ranked
   * after everything the first pass admitted: a direct answer outranks an association, whatever
   * the two scores say, because the two numbers are not on one scale.
   */
  readonly resonant?: readonly FusedItem[];
  /**
   * The current claim in a raw turn's subject family, keyed by the turn's node id. Only the
   * resonant bucket reads it: a turn the query matched directly arrives beside whatever else
   * the query matched, while a turn resonance surfaced alone carries a stated belief with
   * nothing around it, and a turn is never distilled into a claim, so supersession never
   * judges one.
   */
  readonly relatedClaims?: ReadonlyMap<string, RelatedClaim>;
  /**
   * Ids this session was already served, unchanged since (`session-dedup.ts`). They are cut
   * here rather than upstream, so the admitted set that reaches cognition is the same set it
   * has always been and only the wire gets smaller. Empty on a first recall, on a
   * time-traveled read, and whenever the knob is off.
   */
  readonly suppressed?: ReadonlySet<string>;
  /**
   * Ids whose only source is this session's own turns (`session-origin.ts`). Cut here for the
   * same reason and with the same reach as the repeats: the admitted set that reaches cognition
   * is unchanged, and only the wire gets smaller. Empty on a time-traveled read and whenever the
   * knob is off.
   */
  readonly suppressedOwn?: ReadonlySet<string>;
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
 * whose metadata says "degraded" reads to that client exactly like a confident answer, which
 * already cost one full baseline run. The same three signals stay in `metadata` for a
 * structured consumer; this is the copy that reaches everyone.
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
    clauses.push(`${String(pending)} recent episode${pending === 1 ? '' : 's'} not yet enriched`);
  }
  const repeats = input.suppressed?.size ?? 0;
  if (repeats > 0) {
    clauses.push(
      `${String(repeats)} item${repeats === 1 ? '' : 's'} already served this session, unchanged`,
    );
  }
  // Named separately from the repeats, because the two withhold for different reasons and a
  // reader deciding whether to ask again needs to know which one it is looking at.
  const own = input.suppressedOwn?.size ?? 0;
  if (own > 0) {
    clauses.push(`${String(own)} item${own === 1 ? '' : 's'} from this session's own turns`);
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
 *
 * The fused items are laid down first and the resonant ones after, so a direct answer always
 * outranks an association and takes the budget first. Their two scores are not on one scale,
 * so there is no order to merge them into.
 */
function select(input: AssemblePackInput, note: string | undefined): Selection {
  const selection: Selection = new Map();
  const packedEpisodes = new Set<string>();
  const packedIds = new Set<string>();
  const packedContent = new Set<string>();
  // The note is charged with its own blank-line separator: it is text the agent pays for, and
  // a caller that asked for a small budget should not lose an item to it silently.
  let tokens =
    estimateTokens(PACK_HEADING) + (note === undefined ? 0 : estimateTokens(`${note}\n\n`));
  let ranked = 0;
  let glosses = 0;

  /** Cut at the wire by either subtraction: already in this session's context, either way. */
  function withheld(id: string): boolean {
    return input.suppressed?.has(id) === true || input.suppressedOwn?.has(id) === true;
  }

  /** Places the item in the named bucket when the cap and the budget still leave room for it. */
  function accept(item: FusedItem, bucket: PackBucket, gloss: boolean): void {
    const held = selection.get(bucket) ?? [];
    if (held.length >= input.caps[bucket]) {
      return;
    }
    const key = bucket === 'episodes' ? episodeKey(item) : undefined;
    if (key !== undefined && packedEpisodes.has(key)) {
      return;
    }

    // The annotation is charged to the item that carries it, so a claim long enough to cost
    // the pack another memory costs this one its own slot instead.
    const claim = bucket === 'resonant' ? input.relatedClaims?.get(item.id) : undefined;
    const entry: PackEntry = { item: toPackItem(item, ranked + 1, claim), gloss };
    const cost =
      estimateTokens(renderItem(entry)) +
      (held.length === 0 ? estimateTokens(BUCKET_HEADINGS[bucket]) : 0);
    if (tokens + cost > input.tokenBudget) {
      return;
    }

    tokens += cost;
    ranked += 1;
    if (gloss) {
      glosses += 1;
    }
    packedIds.add(item.id);
    packedContent.add(hashContent(item.content));
    held.push(entry);
    selection.set(bucket, held);
    if (key !== undefined) {
      packedEpisodes.add(key);
    }
  }

  for (const item of input.items) {
    if (withheld(item.id)) {
      continue;
    }
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

    accept(item, bucket, gloss);
  }

  // Resonance runs beside fusion rather than inside it, so its hits are the one place a pack
  // could hold the same memory twice. The stage already excludes every id the first pass
  // produced; this catches the other half, a distinct node whose text says the same thing.
  for (const item of input.resonant ?? []) {
    if (withheld(item.id)) {
      continue;
    }
    if (packedIds.has(item.id) || packedContent.has(hashContent(item.content))) {
      continue;
    }
    accept(item, 'resonant', false);
  }

  return selection;
}

function render(
  selection: Selection,
  note: string | undefined,
  admission: AdmissionReport,
  repeats: number,
  own: number,
): string {
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
    sections.push(emptyPackBody(admission, repeats, own));
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
    dropped_unmeasured_arrival: report.droppedUnmeasuredArrival,
    dropped_duplicate_content: report.droppedDuplicateContent,
    dropped_near_duplicate: report.droppedNearDuplicate,
    vector_floor: report.policy.vectorFloor,
    corroboration_floor: report.policy.corroborationFloor,
    bm25_mode: report.policy.bm25Mode,
  };
}

/**
 * The producing method of every item the pack holds, read off the assembled pack rather than
 * off the stages that fed it. Assembly drops items on bucket caps, the budget, the restatement
 * filter, the gloss cap and duplicate keys, and resonance offers up to `resonantLimit` where
 * the pack serves `maxResonant`: counting the stage output credits a mechanism for items no
 * agent ever saw, which is what the spirit metric exists not to do.
 */
export function packMethods(pack: MemoryPack): readonly string[] {
  const methods: string[] = [];
  for (const bucket of PACK_BUCKETS) {
    for (const item of pack[bucket] ?? []) {
      methods.push(item.rationale.method);
    }
  }
  return methods;
}

/**
 * The pack is parsed against its own schema on the way out. Its invariants (a present bucket
 * is never empty, an item always carries content and a rationale) are this module's to hold,
 * so a violation is a defect here and failing loudly beats handing an agent a pack the
 * protocol does not describe.
 */
export function assemblePack(input: AssemblePackInput): MemoryPack {
  const repeats = input.suppressed?.size ?? 0;
  const own = input.suppressedOwn?.size ?? 0;
  const note = honestyNote(input);
  const selection = select(input, note);
  const renderedText = render(selection, note, input.admission, repeats, own);

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
      ...(repeats === 0 ? {} : { suppressed_repeats: repeats }),
      ...(own === 0 ? {} : { suppressed_own: own }),
    },
  });
}

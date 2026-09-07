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
import {
  renderBucket,
  renderItem,
  toPackItem,
  STANDING_LEGEND,
  type ItemAnnotations,
  type PackEntry,
} from './pack-item.js';
import { emptyPackBody, honestyNote } from './pack-notes.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
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

export const PACK_HEADING = '# Memory';

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
   * Standing intentions whose own trigger condition this recall met, best first. Routed to the
   * intentions bucket by how they arrived rather than by their labels, and laid down after
   * everything the query itself found: an answer to what was asked outranks something the
   * substrate volunteered, whatever the two numbers say.
   */
  readonly intentions?: readonly FusedItem[];
  /**
   * The current claim in a raw turn's subject family, keyed by the turn's node id. Every bucket
   * reads it. A turn is captured text, never distilled into a claim, so supersession never
   * judges one and a belief stated in a turn answers as current however often it was corrected
   * since. That holds wherever the turn surfaced, so the annotation belongs on the turn rather
   * than on the way it arrived.
   */
  readonly relatedClaims?: ReadonlyMap<string, RelatedClaim>;
  /**
   * What each candidate descends from and what the substrate holds about it, keyed by node id
   * (`claim-provenance-queries.ts`). Absent for a caller that assembles a pack by hand and for
   * a run whose provenance read failed.
   */
  readonly provenance?: ReadonlyMap<string, ItemProvenance>;
  /**
   * A read pinned to a past vantage point. Superseded material keeps its place in the ranking
   * there and carries no unresolved marker: inspecting what the substrate held then is the
   * question, and preferring a successor written afterwards would answer a different one.
   */
  readonly historical?: boolean;
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
  /**
   * Ids restating an assertion a better-ranked item already carries (`pack-duplicates.ts`). Cut
   * here for the same reason and with the same reach as the other two: the stored records are
   * untouched, cognition sees the full admitted set, and only this pack's budget is smaller.
   */
  readonly suppressedDuplicates?: ReadonlySet<string>;
};

type Selection = Map<PackBucket, PackEntry[]>;

/**
 * Rank order decides everything; the caps and the budget only decide where it stops. An
 * item that would bust the budget is skipped rather than ending assembly, so one oversized
 * memory cannot starve every smaller one ranked under it.
 *
 * The running estimate charges a bucket's heading to its first accepted item, because the
 * heading is text the agent pays for too.
 *
 * The fused items are laid down first, then the triggered intentions, then the resonant ones,
 * so a direct answer always outranks what the substrate volunteered and takes the budget first.
 * The three scores are not on one scale, so there is no order to merge them into.
 */
function select(input: AssemblePackInput, note: string | undefined): Selection {
  const selection: Selection = new Map();
  const packedEpisodes = new Set<string>();
  const packedIds = new Set<string>();
  const packedContent = new Set<string>();
  /** First packed item to claim each root, which is what a later sibling points back at. */
  const rootOwners = new Map<string, string>();
  // The note and the standing legend are charged with their own blank-line separators: both are
  // text the agent pays for, and a caller that asked for a small budget should not lose an item
  // to either of them silently. The legend is charged whether or not the pack ends up with an
  // item to print it above, which errs toward a pack one memory smaller rather than one over.
  let tokens =
    estimateTokens(PACK_HEADING) +
    estimateTokens(`${STANDING_LEGEND}\n\n`) +
    (note === undefined ? 0 : estimateTokens(`${note}\n\n`));
  let ranked = 0;
  let glosses = 0;

  /** Cut at the wire by any of the three subtractions: text the reader already has, either way. */
  function withheld(id: string): boolean {
    return (
      input.suppressed?.has(id) === true ||
      input.suppressedOwn?.has(id) === true ||
      input.suppressedDuplicates?.has(id) === true
    );
  }

  /**
   * Every ancestor the item overlaps on, its own capture included. Overlap is not the same
   * question as display: a capture and a claim pulled out of it are one source, and dropping
   * the capture's own id here (it prints as nothing, since a capture derives from itself) let
   * the two render side by side as though somebody had said it twice.
   */
  function overlapKeysOf(item: FusedItem): readonly string[] {
    const provenance = input.provenance?.get(item.id);
    if (provenance === undefined) {
      return [];
    }
    return provenance.lineage ?? provenance.roots;
  }

  /**
   * Everything the item carries from outside itself, assembled before the cost is measured so
   * an annotation is charged to the item that prints it rather than to the pack's last slot.
   */
  function annotationsFor(item: FusedItem, overlap: readonly string[]): ItemAnnotations {
    const provenance = input.provenance?.get(item.id);
    // The annotation carries a claim the reader would otherwise not see. One the pack already
    // holds is in front of them, and printing it a second time costs the budget a memory to
    // repeat a sentence: the claim is dropped rather than the annotation being suppressed
    // wholesale outside the resonant bucket, which was the older rule and left a turn the query
    // matched head on standing uncontested.
    const found = input.relatedClaims?.get(item.id);
    const claim = found !== undefined && packedIds.has(found.id) ? undefined : found;
    const sharedWith = new Set<string>();
    for (const ancestor of overlap) {
      const owner = rootOwners.get(ancestor);
      if (owner !== undefined && owner !== item.id) {
        sharedWith.add(owner);
      }
    }
    const successorAbsent =
      input.historical !== true &&
      item.currency === 'superseded' &&
      item.supersededBy !== undefined &&
      !packedIds.has(item.supersededBy.id);
    return {
      ...(claim === undefined ? {} : { relatedClaim: claim }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(sharedWith.size === 0 ? {} : { sharedWith: [...sharedWith] }),
      ...(successorAbsent ? { successorAbsent: true } : {}),
    };
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

    const overlap = overlapKeysOf(item);
    const entry: PackEntry = {
      item: toPackItem(item, ranked + 1, annotationsFor(item, overlap)),
      gloss,
    };
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
    // Claimed only once the item is actually in the pack: an item the budget cut is not a
    // witness anyone read, so it must not make the next item look like a second one.
    for (const ancestor of overlap) {
      if (!rootOwners.has(ancestor)) {
        rootOwners.set(ancestor, item.id);
      }
    }
    held.push(entry);
    selection.set(bucket, held);
    if (key !== undefined) {
      packedEpisodes.add(key);
    }
  }

  /**
   * Superseded material goes last across every population, not last within its own. A successor
   * resonance found and a predecessor fusion ranked compete for one budget, and spending it on
   * the predecessor first leaves the correction outside the pack while the thing it corrected
   * is inside it. It is a discount and not a gate: whatever the budget still has room for is
   * served, and a historical read skips the deferral entirely, because what the substrate held
   * then is the question there.
   */
  function deferred(item: FusedItem): boolean {
    return input.historical !== true && item.currency === 'superseded';
  }

  function placeRanked(item: FusedItem): void {
    if (withheld(item.id)) {
      return;
    }
    const bucket = bucketFor(item.labels);
    if (bucket === undefined) {
      return;
    }
    if (bucket === 'facts' && input.restating?.has(item.id) === true) {
      return;
    }

    const gloss = bucket === 'facts' && item.labels.includes(GLOSS_LABEL);
    if (gloss && glosses >= (input.entityGlossCap ?? Number.POSITIVE_INFINITY)) {
      return;
    }

    accept(item, bucket, gloss);
  }

  /**
   * Both stages that run beside fusion rather than inside it are where a pack could hold the
   * same memory twice. Each already excludes every id the run produced before it; this catches
   * the other half, a distinct node whose text says the same thing.
   */
  function placeBeside(item: FusedItem, bucket: PackBucket): void {
    if (withheld(item.id)) {
      return;
    }
    if (packedIds.has(item.id) || packedContent.has(hashContent(item.content))) {
      return;
    }
    accept(item, bucket, false);
  }

  /** Every population in serving order, so one sweep can take the current and a later one the rest. */
  function sweep(wanted: (item: FusedItem) => boolean): void {
    for (const item of input.items) {
      if (wanted(item)) {
        placeRanked(item);
      }
    }
    for (const item of input.intentions ?? []) {
      if (wanted(item)) {
        placeBeside(item, 'intentions');
      }
    }
    for (const item of input.resonant ?? []) {
      if (wanted(item)) {
        placeBeside(item, 'resonant');
      }
    }
  }

  sweep((item) => !deferred(item));
  sweep(deferred);

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
  const buckets: string[] = [];
  for (const bucket of PACK_BUCKETS) {
    const entries = selection.get(bucket);
    if (entries === undefined || entries.length === 0) {
      continue;
    }
    buckets.push(renderBucket(bucket, entries));
  }
  if (buckets.length === 0) {
    sections.push(emptyPackBody(admission, repeats, own));
  } else {
    // The legend explains a word every item below carries, so it goes above them and only when
    // there are items to explain. An empty pack has nothing to key.
    sections.push(STANDING_LEGEND, ...buckets);
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
    typed_admitted: report.typedAdmitted,
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
  const duplicates = input.suppressedDuplicates?.size ?? 0;
  const note = honestyNote({
    ...(input.degraded === undefined ? {} : { degraded: input.degraded }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
    ...(input.pendingEnrichment === undefined
      ? {}
      : { pendingEnrichment: input.pendingEnrichment }),
    repeats,
    own,
    duplicates,
  });
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
      ...(duplicates === 0 ? {} : { suppressed_duplicates: duplicates }),
    },
  });
}

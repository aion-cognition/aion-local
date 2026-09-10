import {
  narrativeSentenceBudget,
  renderItem,
  NARRATIVE_MAX_SENTENCES,
  type NarrativeSource,
  type NarrativeSourceItem,
} from './narrative.js';

/**
 * The chunk path's own renderer.
 *
 * `renderNarrativeSource` prefers an episode's summary, clips every item to a per-item character
 * cap, and drops everything past a member count. All three were sized for a whole-session read and
 * all three are wrong here: a chunk seals on what its members actually render to, so the render
 * has to be the thing that was measured. A member arrives whole or the revision records which
 * ranges of it were submitted; nothing is silently shortened and no summary stands in for the
 * text a sentence is grounded against.
 *
 * Enrichment is what the remaining allowance buys. Extracted nodes are placed only after every
 * member's raw text is in, each one whole or not at all, so an enrichment item can never displace
 * the evidence the narrative is supposed to rest on.
 */

/** How the prompt names a sealed member. The captured experience, in the prompt's own vocabulary. */
export const CHUNK_MEMBER_KIND = 'episode';

/** Two newlines join the rendered items, which admission has to count as well. */
const ITEM_SEPARATOR = '\n\n';

/** One newline joins two submitted ranges of a bounded member. */
const PART_SEPARATOR = '\n';

export type ChunkMemberPart = {
  /** The citation address of the part, which is what a recorded range names. */
  readonly address: string;
  readonly text: string;
};

export type ChunkMemberText = {
  readonly sourceId: string;
  readonly occurredAt?: Date;
  /** The whole captured source as the archive holds it. Never a summary, never clipped. */
  readonly text: string;
  /** The recorded parts in their recorded order, which a bounded partial selects over. */
  readonly parts: readonly ChunkMemberPart[];
};

export type ChunkEnrichmentNode = {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  /** The member that produced it. An enrichment node supported by no admitted member is dropped. */
  readonly sourceId: string;
};

/** A range of one address's text that reached the model, in UTF-16 code units. */
export type SubmittedRange = {
  readonly address: string;
  readonly start: number;
  readonly end: number;
};

export type ChunkRender = {
  readonly source: NarrativeSource;
  /** Empty when every member rendered whole; the exact submitted ranges when one did not. */
  readonly submitted: readonly SubmittedRange[];
  /** Whether every admitted member's full raw text reached the model. */
  readonly complete: boolean;
  readonly renderedUnits: number;
  readonly enrichmentCount: number;
};

export function chunkHandle(index: number): string {
  return `S${String(index + 1)}`;
}

function memberItem(index: number, member: ChunkMemberText, text: string): NarrativeSourceItem {
  return {
    handle: chunkHandle(index),
    id: member.sourceId,
    kind: CHUNK_MEMBER_KIND,
    text,
    ...(member.occurredAt === undefined ? {} : { occurredAt: member.occurredAt }),
  };
}

/**
 * Exactly what the renderer spends on this member at this position, so the seal decision and the
 * render agree to the code unit. The handle widens at ten members and the envelope carries the
 * world time, so neither can be estimated from the text length alone.
 */
export function chunkMemberUnits(index: number, member: ChunkMemberText): number {
  return renderItem(memberItem(index, member, member.text)).length;
}

/** The rendered size of a set of items placed in order, separators included. */
export function joinedUnits(units: readonly number[]): number {
  if (units.length === 0) {
    return 0;
  }
  return (
    units.reduce((total, value) => total + value, 0) + ITEM_SEPARATOR.length * (units.length - 1)
  );
}

/**
 * The deterministic render-side selection over a member no allowance can carry whole.
 *
 * Whole parts in their recorded order while they fit, then a prefix of the first one that does
 * not. Prefix rather than a middle window because a selection a reader cannot reconstruct from
 * the recorded ranges is a selection nobody can audit; the ranges below name every submitted
 * unit, and everything outside them is the gap the revision records.
 */
export function selectSubmittedRanges(
  member: ChunkMemberText,
  allowance: number,
): readonly SubmittedRange[] {
  const parts =
    member.parts.length > 0 ? member.parts : [{ address: member.sourceId, text: member.text }];
  const ranges: SubmittedRange[] = [];
  let remaining = allowance;
  for (const part of parts) {
    // The separator that would join this range to the one before it is charged BEFORE the range
    // is chosen. Charging it afterwards spends a unit the selection had already committed, which
    // is how a nine-unit budget submits ten units.
    const separator = ranges.length === 0 ? 0 : PART_SEPARATOR.length;
    if (remaining - separator <= 0) {
      break;
    }
    const end = Math.min(part.text.length, remaining - separator);
    if (end === 0) {
      continue;
    }
    ranges.push({ address: part.address, start: 0, end });
    remaining -= separator + end;
  }
  return ranges;
}

function submittedText(member: ChunkMemberText, ranges: readonly SubmittedRange[]): string {
  const byAddress = new Map(
    (member.parts.length > 0
      ? member.parts
      : [{ address: member.sourceId, text: member.text }]
    ).map((part) => [part.address, part.text]),
  );
  return ranges
    .map((range) => (byAddress.get(range.address) ?? '').slice(range.start, range.end))
    .join(PART_SEPARATOR);
}

export type ChunkRenderInput = {
  readonly members: readonly ChunkMemberText[];
  readonly enrichment: readonly ChunkEnrichmentNode[];
  readonly allowance: number;
  readonly maxSentences?: number;
  /**
   * The one member this render is allowed to submit part of. Present only for the chunk that
   * sealed around a single member no allowance carries whole.
   */
  readonly boundedPartialOf?: string;
  /**
   * The units that member's TEXT may spend, once every required whole input beside it has been
   * reserved. Absent, the render reserves only that member's own envelope, which is the right
   * answer when it is the only thing being placed and the wrong one when a required correction
   * has to fit as well.
   */
  readonly boundedPartialAllowance?: number;
};

/**
 * The chunk's model input, and the exact record of what reached it.
 *
 * A member is placed whole unless it is the named bounded partial, and an enrichment node is
 * placed only if the remaining allowance carries it whole. `complete` is what lets the revision
 * assert coverage 1.0 rather than a fraction nobody can check.
 */
export function renderSealedChunk(input: ChunkRenderInput): ChunkRender {
  const items: NarrativeSourceItem[] = [];
  const unitsSoFar: number[] = [];
  const submitted: SubmittedRange[] = [];
  let complete = true;

  for (const member of input.members) {
    const index = items.length;
    if (member.sourceId === input.boundedPartialOf) {
      // The envelope is charged first: the allowance buys text, and the header naming the member
      // is not text the selection may spend.
      const envelope = chunkMemberUnits(index, { ...member, text: '' });
      const ranges = selectSubmittedRanges(
        member,
        Math.max(0, input.boundedPartialAllowance ?? input.allowance - envelope),
      );
      const text = submittedText(member, ranges);
      const item = memberItem(index, member, text);
      submitted.push(...ranges);
      complete = text.length === member.text.length;
      items.push(item);
      unitsSoFar.push(renderItem(item).length);
      continue;
    }
    items.push(memberItem(index, member, member.text));
    unitsSoFar.push(chunkMemberUnits(index, member));
  }

  const admitted = new Set(input.members.map((member) => member.sourceId));
  let spent = joinedUnits(unitsSoFar);
  let enrichmentCount = 0;
  for (const node of input.enrichment) {
    // Enrichment supported only by a member this render does not carry is not enrichment; it is
    // the omitted member's content arriving by another door.
    if (!admitted.has(node.sourceId)) {
      continue;
    }
    const index = items.length;
    const item: NarrativeSourceItem = {
      handle: chunkHandle(index),
      id: node.id,
      kind: node.kind,
      text: node.text,
    };
    const cost = renderItem(item).length + ITEM_SEPARATOR.length;
    if (spent + cost > input.allowance) {
      continue;
    }
    items.push(item);
    spent += cost;
    enrichmentCount += 1;
  }

  const text = items.map(renderItem).join(ITEM_SEPARATOR);
  return {
    source: {
      text,
      items,
      renderedCount: input.members.length,
      coverage: complete ? 1 : coverageOf(input.members, submitted),
      sentenceBudget: narrativeSentenceBudget(
        items,
        input.maxSentences ?? NARRATIVE_MAX_SENTENCES,
        input.members.length,
      ),
    },
    submitted,
    complete,
    renderedUnits: text.length,
    enrichmentCount,
  };
}

/**
 * The fraction of the members' raw text that was submitted, rounded the way the node stores it.
 *
 * Only ever consulted for the chunk that sealed around one member, which is the only render that
 * can be incomplete: the ranges name that member's submission and the total is that member's text.
 */
function coverageOf(
  members: readonly ChunkMemberText[],
  submitted: readonly SubmittedRange[],
): number {
  const total = members.reduce((sum, member) => sum + member.text.length, 0);
  if (total === 0) {
    return 0;
  }
  const sent = submitted.reduce((sum, range) => sum + (range.end - range.start), 0);
  return Math.round((sent / total) * 1000) / 1000;
}

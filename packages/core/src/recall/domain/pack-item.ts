import type { AdmissionRule, MemoryPackItem, RelatedClaim } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { BUCKET_HEADINGS, type PackBucket } from './pack-buckets.js';

/**
 * One item as the pack holds it and as the agent reads it: the wire shape, and the two or
 * three rendered lines under its number. Everything here is about a single memory, so the
 * budget and the caps in `pack.ts` never enter it.
 */

/**
 * An item plus the one thing the wire item cannot carry: whether it is an entity gloss.
 * Labels are graph vocabulary and stay out of the protocol, but the gloss cap counts them
 * and the provenance-age annotation only applies to them.
 */
export type PackEntry = {
  readonly item: MemoryPackItem;
  readonly gloss: boolean;
};

/**
 * The extraction prompt asks for one sentence, so most stored rationales land well under this;
 * the cap guards the rare long one, so a single node's why can never claim a disproportionate
 * share of the token budget. Cut at the last whole word under the limit rather than mid-word.
 */
export const MAX_WHY_CHARS = 220;

/** A claim is one extracted sentence, so it is capped where a stored why is, and for the same reason. */
export const MAX_RELATED_CLAIM_CHARS = 220;

function capText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

/** How each admission rule names itself in the rendered line. */
const RULE_PHRASES: Readonly<Record<AdmissionRule, string>> = {
  vector_floor: 'vector floor',
  exact_match: 'exact match',
  corroborated: 'corroborated',
  bm25_any: 'uncalibrated lexical hit',
  context_threshold: 'context threshold',
};

/**
 * The rule that admitted the item and what qualified under it, in place of a bare number.
 * A number alone cannot say which floor judged it, and the two are not always the same
 * quantity: corroboration admits on two legs agreeing, and a literal match admits on no
 * measurement at all.
 *
 * The fallback is for an item assembled without the gate having run, where zero still means
 * a literal match: printing "confidence 0.00" beside a memory that answered exactly would
 * read as the opposite of what admitted it.
 */
function renderAdmission(item: MemoryPackItem): string {
  const admitted = item.admitted_by;
  if (admitted === undefined) {
    return item.confidence === 0 ? 'exact match' : `confidence ${item.confidence.toFixed(2)}`;
  }
  return `${RULE_PHRASES[admitted.rule]}: ${admitted.evidence.join(' + ')}`;
}

export function toPackItem(
  item: FusedItem,
  rank: number,
  relatedClaim?: RelatedClaim,
): MemoryPackItem {
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
    ...(item.admittedBy === undefined
      ? {}
      : {
          admitted_by: {
            rule: item.admittedBy.rule,
            evidence: [...item.admittedBy.qualifying],
          },
        }),
    ...(item.why === undefined ? {} : { why: capText(item.why, MAX_WHY_CHARS) }),
    currency: item.currency,
    ...(item.supersededBy === undefined
      ? {}
      : {
          superseded_by: {
            id: item.supersededBy.id,
            at: item.supersededBy.at.toISOString(),
          },
        }),
    ...(relatedClaim === undefined
      ? {}
      : {
          related_claim: {
            id: relatedClaim.id,
            text: capText(relatedClaim.text, MAX_RELATED_CLAIM_CHARS),
          },
        }),
  };
}

/** Calendar day only: the age is the point, and a timestamp to the millisecond hides it. */
function renderDay(timestamp: string): string {
  return timestamp.slice(0, 'YYYY-MM-DD'.length);
}

/**
 * Content on its own line, then the node's own reason when it stored one, then one line of
 * provenance: id, the method that found it, the rule that admitted it with the evidence that
 * qualified, the path for an activated item, and the lineage marker for a superseded one. The
 * marker belongs wherever superseded knowledge surfaces, so it is part of the rendered block
 * and not only of the structured item.
 *
 * A raw turn in the resonant bucket closes with the current claim from its subject family,
 * when it has one. A turn is captured text and is never distilled into a claim, so nothing
 * ever supersedes it and it surfaces as current however often it was later corrected. The
 * annotation states no verdict: it puts the current claim in front of the reader, who
 * arbitrates.
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
export function renderItem(entry: PackEntry): string {
  const { item } = entry;
  const facts = [`[${item.id}]`, item.rationale.method, renderAdmission(item)];
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
  const why = item.why === undefined ? '' : `\n   why: ${item.why}`;
  const related =
    item.related_claim === undefined
      ? ''
      : `\n   current related claim: ${item.related_claim.text} [${item.related_claim.id}]`;
  return `${String(item.rank)}. ${item.content}${why}\n   ${facts.join(' | ')}${related}`;
}

export function renderBucket(bucket: PackBucket, entries: readonly PackEntry[]): string {
  const blocks = entries.map((entry) => renderItem(entry));
  return `${BUCKET_HEADINGS[bucket]}\n${blocks.join('\n')}`;
}

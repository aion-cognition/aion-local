import type {
  AdmissionRule,
  Derivation,
  MemoryPackItem,
  RelatedClaim,
  Standing,
  StandingKind,
} from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { BUCKET_HEADINGS, PACK_BUCKETS, type PackBucket } from './pack-buckets.js';
import { standingFor } from './standing.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';

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

/**
 * The prompt asks a contextual preference to name its situation in a clause, so this cap guards
 * the rare long one. It is never dropped instead of cut: the condition is part of the preference,
 * and a preference served without it reads as one that holds everywhere.
 */
export const MAX_CONTEXT_CHARS = 220;

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
  typed_admission: 'typed tier',
  path_strength: 'path strength',
  assessment: 'selected by assessment over the floor',
};

/**
 * The rule that admitted the item and what qualified under it, in place of a bare number.
 * A number alone cannot say which floor judged it, and the two are not always the same
 * quantity: corroboration admits on two legs agreeing, and a literal match admits on no
 * measurement at all.
 *
 * The fallback prints the number alone, for an item no rule judged. A triggered intention is
 * the one such item the pack serves: it came back because a date passed or its subject was in
 * play, and it was never measured against the query at all.
 */
function renderAdmission(item: MemoryPackItem): string {
  const admitted = item.admitted_by;
  if (admitted === undefined) {
    return `confidence ${item.confidence.toFixed(2)}`;
  }
  return `${RULE_PHRASES[admitted.rule]}: ${admitted.evidence.join(' + ')}`;
}

/**
 * Everything about an item the pack learned from somewhere other than the item itself: the
 * current claim in its subject family, its source record, the other pack items that share one
 * of its roots, and whether the pack holds what replaced it.
 */
export type ItemAnnotations = {
  readonly relatedClaim?: RelatedClaim;
  readonly provenance?: ItemProvenance;
  /** Ids of other items in this pack descending from one of the same roots. */
  readonly sharedWith?: readonly string[];
  /** Set when the item is superseded and its successor is nowhere in this pack. */
  readonly successorAbsent?: boolean;
};

/**
 * What the item descends from, with its own id taken out: a capture that names no source
 * stands as its own root, and printing "derives from itself" says nothing. What survives the
 * filter is a real ancestor, and `shared_with` is what stops two of them reading as two
 * independent witnesses.
 *
 * The overlap is asked before the derivation is dropped. A capture whose own claim is already in
 * the pack has nothing to say about its ancestors and everything to say about that claim, and
 * dropping the whole derivation on the empty root list let the same pair read as one witness or
 * as two depending on which of them assembly reached first.
 */
function derivationOf(itemId: string, annotations: ItemAnnotations): Derivation | undefined {
  const { provenance } = annotations;
  if (provenance === undefined) {
    return undefined;
  }
  const roots = provenance.roots.filter((root) => root !== itemId);
  const shared = annotations.sharedWith ?? [];
  if (roots.length === 0 && provenance.complete && shared.length === 0) {
    return undefined;
  }
  return {
    roots,
    complete: provenance.complete,
    ...(shared.length === 0 ? {} : { shared_with: [...shared] }),
  };
}

export function toPackItem(
  item: FusedItem,
  rank: number,
  annotations: ItemAnnotations = {},
): MemoryPackItem {
  const { relatedClaim } = annotations;
  const derivation = derivationOf(item.id, annotations);
  const correction = annotations.provenance?.claimedCorrection;
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
    ...(item.context === undefined ? {} : { context: capText(item.context, MAX_CONTEXT_CHARS) }),
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
    standing: standingFor(item, annotations.provenance),
    ...(derivation === undefined ? {} : { derivation }),
    ...(correction === undefined
      ? {}
      : { claimed_correction: { by: correction.by, at: correction.at.toISOString() } }),
    ...(annotations.successorAbsent === true ? { successor_absent: true as const } : {}),
  };
}

/** Calendar day only: the age is the point, and a timestamp to the millisecond hides it. */
function renderDay(timestamp: string): string {
  return timestamp.slice(0, 'YYYY-MM-DD'.length);
}

/**
 * How each kind of statement names itself, one word each.
 *
 * A bucket heading does not supply this: `Facts` holds extracted claims beside entity
 * descriptions, and `Resonant` holds whatever the second pass reached, so a reader working from
 * the heading alone cannot tell a sentence somebody typed from one a model drew out of it. The
 * word is the whole distinction and it costs about a token, which is what makes it affordable
 * on every memory in the pack.
 */
const STANDING_PHRASES: Readonly<Record<StandingKind, string>> = {
  recorded_utterance: 'said',
  recorded_session: 'captured',
  recorded_decision: 'decided',
  extracted_interpretation: 'inferred',
  synthesized: 'summarized',
  stated_description: 'described',
  drawn_conclusion: 'concluded',
  // The same word an extracted interpretation prints. The two are separate kinds on the wire,
  // where an inspection can tell them apart, and one word in the pack, where the Preferences
  // heading above the item already supplies the noun and a second legend entry would cost every
  // pack ever assembled a few tokens to say what the heading says.
  inferred_preference: 'inferred',
};

/**
 * One line under the pack heading, so the per-item words stay one word.
 *
 * Authorship is the part every item would otherwise restate: nearly every memory the substrate
 * holds is unattributed, and printing that on each of them tells the reader nothing new and
 * costs a whole memory of budget across a full pack. Saying it once, as the default, leaves the
 * item line to carry only the departures from it: a recorded role, or a confirmation.
 */
export const STANDING_LEGEND =
  'standing: said, decided, inferred, captured, summarized, described, concluded.' +
  ' Authorship is unattributed unless a line names a role or a confirmation.';

/**
 * The kind, what the substrate can say about who stands behind it, and whether it stands alone.
 *
 * Only an utterance carries a role, so the authorship clause prints exactly there: the role
 * verbatim, then "authorship unknown", because the role is a label the calling client set and
 * agent-to-agent traffic arrives under `user`. An attributed item says nothing there: its
 * confirmation line below names the confirmer and cites the evidence.
 *
 * The contest prints on the item and not once in the legend, because it is true of this reading
 * rather than of the vocabulary: a pack may serve one contested conclusion beside a dozen sole
 * ones, and a legend entry would say it of all of them.
 */
function renderStanding(standing: Standing): string {
  const kind = STANDING_PHRASES[standing.kind];
  const contest =
    standing.contested === true
      ? ', contested: a competing reading of the same memories stands'
      : '';
  if (standing.attribution === 'attributed' || standing.recorded_role === undefined) {
    return `${kind}${contest}`;
  }
  return `${kind}, role ${standing.recorded_role}, authorship unknown${contest}`;
}

/**
 * The source line, printed only when it changes how the item should be read: another item in
 * this pack came from the same place, or the chain is short. A bare ancestor is on the wire
 * item and reachable from the node itself, and printing it under every extracted claim
 * measured two memories out of twelve at the shipped token budget, which is a worse trade than
 * the line is worth.
 *
 * `shared_with` is the part a reader cannot reconstruct: two items pulled out of one capture
 * say the same thing once, and a pack that prints both without saying so lets one source count
 * as two.
 */
function renderDerivation(derivation: Derivation): string {
  const shared =
    derivation.shared_with === undefined
      ? ''
      : `\n   shares this origin with ${derivation.shared_with.join(', ')}:` +
        ' not independent corroboration';
  if (derivation.complete) {
    return shared;
  }
  const roots =
    derivation.roots.length === 0 ? 'an unrecorded source' : derivation.roots.join(', ');
  return `\n   derives from ${roots} (lineage incomplete)${shared}`;
}

/**
 * Content on its own line, then the condition a contextual preference holds under, then the
 * node's own reason when it stored one, then one line of provenance: id, the method that found
 * it, the rule that admitted it with the evidence that qualified, the path for an activated item,
 * and the lineage marker for a superseded one. The marker belongs wherever superseded knowledge
 * surfaces, so it is part of the rendered block and not only of the structured item.
 *
 * The condition sits directly under the sentence it narrows, because the two are one statement
 * and a reader who acts on the first line alone has acted outside it.
 *
 * An aged-out reading is marked too, and it needs its own word: nothing superseded it, so it
 * has no lineage line, and the reading beside its occurrence date is otherwise indistinguishable
 * from a measurement the substrate still stands behind.
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
  if (item.standing !== undefined) {
    facts.push(renderStanding(item.standing));
  }
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
  // The successor is named in the lineage marker either way, and a reader has no way to tell
  // whether the id points at something in front of them or at something they would have to ask
  // for. Unresolved superseded material is exactly what a correction-aware pack has to mark.
  if (item.successor_absent === true) {
    facts.push('successor not served');
  }
  if (item.currency === 'expired') {
    facts.push('expired');
  }
  const why = item.why === undefined ? '' : `\n   why: ${item.why}`;
  const held = item.context === undefined ? '' : `\n   holds when: ${item.context}`;
  const confirmed =
    item.standing?.confirmed === undefined
      ? ''
      : `\n   confirmed by ${item.standing.confirmed.by} at ${item.standing.confirmed.at},` +
        ` evidence: ${item.standing.confirmed.evidence}`;
  const correction =
    item.claimed_correction === undefined
      ? ''
      : `\n   correction stated by ${item.claimed_correction.by} at ${item.claimed_correction.at},` +
        ' nothing has closed it';
  const derivation = item.derivation === undefined ? '' : renderDerivation(item.derivation);
  const related =
    item.related_claim === undefined
      ? ''
      : `\n   current related claim: ${item.related_claim.text} [${item.related_claim.id}]`;
  return (
    `${String(item.rank)}. ${item.content}${held}${why}\n   ${facts.join(' | ')}` +
    `${confirmed}${correction}${derivation}${related}`
  );
}

/**
 * One candidate as the recall assessment reads it: the memory, what kind of statement it is, when
 * it happened, and whether it still holds, in the words the pack itself uses. How retrieval found
 * it and what it scored stay off, because they say how the memory was found rather than whether
 * it helps, and they are the ranking the assessment is there to judge rather than repeat.
 *
 * A successor or a related claim among the other candidates is named by its number, so the model
 * can weigh a correction against what it corrects.
 */
export function renderCandidate(
  item: MemoryPackItem,
  kind: string,
  numberOf: (id: string) => number | undefined,
): string {
  const facts = [kind];
  if (item.standing !== undefined) {
    facts.push(renderStanding(item.standing));
  }
  if (item.occurred_at !== undefined) {
    facts.push(`occurred ${item.occurred_at}`);
  }
  if (item.superseded_by !== undefined) {
    const successor = numberOf(item.superseded_by.id);
    facts.push(
      successor === undefined
        ? `superseded ${renderDay(item.superseded_by.at)}, successor not among these`
        : `superseded ${renderDay(item.superseded_by.at)} by #${String(successor)}`,
    );
  }
  if (item.currency === 'expired') {
    facts.push('expired');
  }
  const held = item.context === undefined ? '' : `\n   holds when: ${item.context}`;
  const why = item.why === undefined ? '' : `\n   why: ${item.why}`;
  const correction =
    item.claimed_correction === undefined
      ? ''
      : `\n   a correction of it was stated ${renderDay(item.claimed_correction.at)}`;
  const related =
    item.related_claim === undefined
      ? ''
      : `\n   current related claim: ${item.related_claim.text}`;
  return (
    `${String(item.rank)}. ${item.content}${held}${why}\n   ${facts.join(' | ')}` +
    `${correction}${related}`
  );
}

export function renderBucket(bucket: PackBucket, entries: readonly PackEntry[]): string {
  const blocks = entries.map((entry) => renderItem(entry));
  return `${BUCKET_HEADINGS[bucket]}\n${blocks.join('\n')}`;
}

export const PACK_HEADING = '# Memory';

/** The whole rendered block: the note, then the legend and the buckets, or what an empty pack says. */
export function renderPack(
  selection: ReadonlyMap<PackBucket, readonly PackEntry[]>,
  note: string | undefined,
  emptyBody: () => string,
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
    sections.push(emptyBody());
  } else {
    // The legend explains a word every item below carries, so it goes above them and only when
    // there are items to explain. An empty pack has nothing to key.
    sections.push(STANDING_LEGEND, ...buckets);
  }
  return `${PACK_HEADING}\n\n${sections.join('\n\n')}`;
}

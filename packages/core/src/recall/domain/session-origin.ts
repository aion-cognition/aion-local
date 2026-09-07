import type { RelatedClaim } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ItemOrigin } from '../../infrastructure/graph/origin-queries.js';

/**
 * The other serving-layer subtraction, and the one `session-dedup.ts` cannot make. A turn is
 * reflected into the graph on the stop hook that ends it, and the next prompt's recall finds
 * that turn and the claims extracted from it as memories the session has never been served.
 * They are new to the record and old to the reader: the conversation that produced them is
 * still holding them, so rendering them spends the pack's budget restating the agent to itself.
 *
 * Dedup cannot catch this, because each of these is served exactly once. What separates them is
 * where they came from, not how often they have been sent.
 *
 * Cognition is untouched, exactly as with dedup: the full admitted set still reaches
 * reinforcement and access tracking, and only the wire gets smaller. The pack-method counters
 * are the one exception, and by design: they are read off the assembled pack, so a withheld
 * item's method is uncredited there.
 */

export type OwnSessionInput = {
  readonly items: readonly FusedItem[];
  /**
   * What the origin read resolved, by item id. An id with no entry is an item whose provenance
   * nothing answered for, and it serves: withholding a memory on a failed lookup is the one
   * error this subtraction must not make.
   */
  readonly origins: ReadonlyMap<string, ItemOrigin>;
  /** The current claim beside a raw turn, keyed as the pack would annotate it. */
  readonly relatedClaims: ReadonlyMap<string, RelatedClaim>;
  /**
   * What the substrate holds about each candidate (`claim-provenance-queries.ts`), the same read
   * the pack renders standing from. An id with no entry is one this run established nothing for,
   * and it serves for the same reason an unresolved origin does.
   */
  readonly provenance: ReadonlyMap<string, ItemProvenance>;
};

/**
 * Whether the graph now says something about the item that the session's own turn did not.
 *
 * Two of the four fields the served fingerprint hashes can move without the node changing
 * identity, and both of them are the substrate correcting the session: a closed lineage, and
 * the currency marker that goes with it. A cognitive node's content and stored why cannot move
 * under one id, because its id is folded from its own text, so a reworded claim is a different
 * node. An entity is the exception: its description is rewritten in place, so a regrown gloss
 * on an entity only this session ever mentioned is withheld, which this knowingly accepts.
 *
 * The related-claim annotation is the third signal and the one a raw turn carries: nothing ever
 * supersedes a turn, so a turn the substrate has since contradicted surfaces as current, and the
 * annotation beside it is the whole of the news.
 *
 * A stated correction and a confirmation are the last two, and they are read off the graph rather
 * than guessed from a role or a score. Neither moves the node's capture origin, so the memory is
 * still this session's own record; what changed is that somebody else put evidence beside it, and
 * that evidence reaches the session through this pack or through nothing. A withheld own memory
 * leaves no served row, so no later subtraction can hand it over instead.
 *
 * An expired reading is not one of these. A horizon is a clock running out on a measurement
 * the session itself made, and the session holds every word of it; the substrate has said
 * nothing new, so serving it back is the echo this subtraction exists to stop.
 */
function newSinceCapture(
  item: FusedItem,
  claims: ReadonlyMap<string, RelatedClaim>,
  record: ItemProvenance,
): boolean {
  return (
    item.currency === 'superseded' ||
    item.supersededBy !== undefined ||
    claims.has(item.id) ||
    record.claimedCorrection !== undefined ||
    record.confirmation !== undefined
  );
}

/**
 * The ids to leave out of the pack: everything whose provenance names this session and no other.
 * An item some other session also produced is a shared memory rather than an echo, and an entity
 * is shared by construction as soon as a second session mentions it.
 *
 * `origins` empty is the whole exemption: a time-traveled read, a disabled knob and a failed
 * lookup all arrive here with nothing to match against, so none of them can suppress anything.
 */
export function suppressedOwnSession(input: OwnSessionInput): ReadonlySet<string> {
  const suppressed = new Set<string>();
  if (input.origins.size === 0) {
    return suppressed;
  }
  for (const item of input.items) {
    const origin = input.origins.get(item.id);
    if (origin === undefined || !origin.own || origin.other) {
      continue;
    }
    const record = input.provenance.get(item.id);
    // A read that did not answer for this item cannot say whether anybody put evidence beside it,
    // and asserting the session already knows what nobody could read is the worse mistake.
    if (record === undefined) {
      continue;
    }
    if (newSinceCapture(item, input.relatedClaims, record)) {
      continue;
    }
    suppressed.add(item.id);
  }
  return suppressed;
}

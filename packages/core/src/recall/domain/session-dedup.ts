import type { MemoryPack } from '@aion/protocol';
import { packBuckets } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import { standingFor } from './standing.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ServedItem } from '../../infrastructure/sqlite/served-items.js';
import { hashContent } from '../../reflection/domain/content.js';

/**
 * The serving-layer subtraction. A hook-driven agent recalls on every prompt, and inside one
 * session the top of the ranked list barely moves, so the same memories are rendered again
 * into a conversation that already holds them. Ranking is untouched by this: fusion still
 * measures everything it admitted, and the pack-method counters still read the whole set. Only
 * what goes over the wire is cut.
 *
 * Suppression is per (session, item) and never crosses sessions: a second agent, or the same
 * agent tomorrow, holds none of this and gets the full pack.
 */

/**
 * What an item said the last time it was served, as one hash. The node's own `updated_at` is
 * the other candidate and is a weaker signal here: it is not hydrated onto a candidate, and it
 * does not move when a supersession closes the node, which changes the rendered line from a
 * current fact into one with a lineage marker. These fields are exactly the parts of a
 * rendered item that can change, so the hash moves when, and only when, the agent would read
 * something new.
 *
 * Standing is in for the same reason the lineage marker is. A confirmation arriving, or a
 * stated correction landing against a line the session already read, changes what the memory
 * means without touching a character of its text, and a correction that never re-serves is a
 * correction nobody sees.
 *
 * The rank, the score and the admitting rule are deliberately out: they move with the query,
 * not with the memory, and hashing them would re-serve everything on every reworded prompt.
 * So is `shared_with`, which is a fact about one pack rather than about the memory.
 */
export function servedFingerprint(item: FusedItem, provenance?: ItemProvenance): string {
  const standing = standingFor(item, provenance);
  return hashContent({
    content: item.content,
    currency: item.currency,
    supersededBy: item.supersededBy?.id ?? null,
    why: item.why ?? null,
    standing: `${standing.kind}:${standing.attribution}:${standing.recorded_role ?? ''}`,
    confirmed: standing.confirmed === undefined ? null : JSON.stringify(standing.confirmed),
    correctedBy: provenance?.claimedCorrection?.by ?? null,
    roots: (provenance?.roots ?? []).join(','),
    lineageComplete: provenance?.complete ?? null,
  });
}

/**
 * The ids to leave out of the pack: served in this session already, and saying the same thing
 * now as they said then. An item with no row is new to the session, and an item whose
 * fingerprint moved (superseded, description regrown, currency changed) is told again in full.
 *
 * `served` empty is the whole exemption: a time-traveled read and a disabled knob both arrive
 * here with nothing to match against, so neither can suppress anything.
 */
export function suppressedRepeats(
  items: readonly FusedItem[],
  served: ReadonlyMap<string, string>,
  provenance?: ReadonlyMap<string, ItemProvenance>,
): ReadonlySet<string> {
  const suppressed = new Set<string>();
  if (served.size === 0) {
    return suppressed;
  }
  for (const item of items) {
    if (served.get(item.id) === servedFingerprint(item, provenance?.get(item.id))) {
      suppressed.add(item.id);
    }
  }
  return suppressed;
}

/**
 * What the session holds once this pack is handed over: every item the pack rendered, plus
 * every repeat it withheld, which the agent still has from the recall that first served it.
 *
 * Two questions have this one answer. It is what the next recall in this session subtracts
 * against, and it is the population recall's exposure side effects are charged to. A memory a
 * bucket cap, the token budget, the near-duplicate fold or the admission floor turned away is
 * absent from both, and so is one origin suppression cut, which the session wrote itself and
 * never read back from a pack.
 */
export function finalPackMembership(
  pack: MemoryPack,
  suppressed: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>(suppressed);
  for (const items of Object.values(packBuckets(pack))) {
    for (const item of items) {
      ids.add(item.id);
    }
  }
  return ids;
}

/** One fingerprint per member, which is what the next recall in this session matches against. */
export function servedRecords(
  membership: ReadonlySet<string>,
  candidates: ReadonlyMap<string, FusedItem>,
  provenance?: ReadonlyMap<string, ItemProvenance>,
): readonly ServedItem[] {
  const records: ServedItem[] = [];
  for (const id of membership) {
    const candidate = candidates.get(id);
    if (candidate === undefined) {
      continue;
    }
    records.push({ itemId: id, fingerprint: servedFingerprint(candidate, provenance?.get(id)) });
  }
  return records;
}

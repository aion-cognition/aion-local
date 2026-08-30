import type { MemoryPack } from '@aion/protocol';
import { packBuckets } from '@aion/protocol';

import type { FusedItem } from './fusion.js';
import type { ServedItem } from '../../infrastructure/sqlite/served-items.js';
import { hashContent } from '../../reflection/domain/content.js';

/**
 * The serving-layer subtraction. A hook-driven agent recalls on every prompt, and inside one
 * session the top of the ranked list barely moves, so the same memories are rendered again
 * into a conversation that already holds them. Cognition is untouched by this: the full
 * admitted set still reaches reinforcement, access tracking and the pack-method counters. Only
 * what goes over the wire is cut.
 *
 * Suppression is per (session, item) and never crosses sessions: a second agent, or the same
 * agent tomorrow, holds none of this and gets the full pack.
 */

/**
 * What an item said the last time it was served, as one hash. The node's own `updated_at` is
 * the other candidate and is a weaker signal here: it is not hydrated onto a candidate, and it
 * does not move when a supersession closes the node, which changes the rendered line from a
 * current fact into one with a lineage marker. These four fields are exactly the parts of a
 * rendered item that can change, so the hash moves when, and only when, the agent would read
 * something new.
 *
 * The rank, the score and the admitting rule are deliberately out: they move with the query,
 * not with the memory, and hashing them would re-serve everything on every reworded prompt.
 */
export function servedFingerprint(item: FusedItem): string {
  return hashContent({
    content: item.content,
    currency: item.currency,
    supersededBy: item.supersededBy?.id ?? null,
    why: item.why ?? null,
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
): ReadonlySet<string> {
  const suppressed = new Set<string>();
  if (served.size === 0) {
    return suppressed;
  }
  for (const item of items) {
    if (served.get(item.id) === servedFingerprint(item)) {
      suppressed.add(item.id);
    }
  }
  return suppressed;
}

/**
 * What the session holds once this pack is handed over: every item the pack rendered, plus
 * every repeat it withheld, which the agent still has from the recall that first served it.
 * Items a bucket cap or the token budget cut are deliberately absent, since a memory the
 * caller never saw must not be subtracted from the next pack.
 */
export function servedRecords(
  pack: MemoryPack,
  suppressed: ReadonlySet<string>,
  candidates: ReadonlyMap<string, FusedItem>,
): readonly ServedItem[] {
  const ids = new Set<string>(suppressed);
  for (const items of Object.values(packBuckets(pack))) {
    for (const item of items) {
      ids.add(item.id);
    }
  }

  const records: ServedItem[] = [];
  for (const id of ids) {
    const candidate = candidates.get(id);
    if (candidate === undefined) {
      continue;
    }
    records.push({ itemId: id, fingerprint: servedFingerprint(candidate) });
  }
  return records;
}

import type { MemoryPack } from '@aion/protocol';

import type { RestatedClaimPair } from '../../infrastructure/graph/near-duplicate-queries.js';
import type { FusedItem } from '../domain/fusion.js';
import type { PackDecision } from '../domain/pack-decisions.js';
import { foldableClaims } from '../domain/pack-duplicates.js';
import { assemblePack, type AssemblePackInput } from '../domain/pack.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';
import { suppressedRepeats } from '../domain/session-dedup.js';
import { suppressedOwnSession } from '../domain/session-origin.js';

/**
 * The three serving subtractions and the assembly that reads them, as one step over one reading.
 *
 * It is a step rather than a stretch of the pipeline because it can be taken twice. Every
 * decision below rests on what the attempt could certify, and a position the substrate would not
 * honour at the end leaves those decisions resting on nothing: the answer is then rebuilt from
 * the same candidates under a reading that admits what it could not establish. Nothing here
 * reads a store, calls a provider or re-ranks, so the second pass costs what a fold costs.
 */

/** What assembly needs that no reading of the substrate can change. */
export type PackAssembly = Omit<
  AssemblePackInput,
  'suppressed' | 'suppressedOwn' | 'foldable' | 'relatedClaims' | 'provenance' | 'onDecision'
>;

export type ServingAssembly = {
  /** Every candidate the run holds, in rank order. */
  readonly ranked: readonly FusedItem[];
  /** What this session already holds. Empty when dedup is off or a reset is staged. */
  readonly served: ReadonlyMap<string, string>;
  readonly dedup: boolean;
  readonly restated: readonly RestatedClaimPair[];
  readonly assembly: PackAssembly;
};

export type ServedAnswer = {
  readonly suppressedOwn: ReadonlySet<string>;
  readonly suppressed: ReadonlySet<string>;
  readonly foldable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly pack: MemoryPack;
};

/**
 * One reading in, one answer out.
 *
 * Origin decides first, and what it withholds leaves no served row: the session never read those
 * items, so a later recall must be free to offer them the moment they stop being its own record.
 * Dedup then judges what is left, and the fold is only made eligible here — assembly decides it,
 * because an item the other two already cut, or one the budget turns away, is not a copy anybody
 * read and so cannot stand in for another.
 */
export function serveFrom(
  input: ServingAssembly,
  view: ResolvedEvidenceView,
  onDecision?: (decision: PackDecision) => void,
): ServedAnswer {
  const suppressedOwn = suppressedOwnSession({ items: input.ranked, view });
  const suppressed = input.dedup
    ? suppressedRepeats(
        input.ranked.filter((item) => !suppressedOwn.has(item.id)),
        input.served,
        view,
      )
    : new Set<string>();
  const foldable = foldableClaims({ items: input.ranked, pairs: input.restated, view });
  const pack = assemblePack({
    ...input.assembly,
    ...(onDecision === undefined ? {} : { onDecision }),
    ...(view.relatedClaims.size === 0 ? {} : { relatedClaims: view.relatedClaims }),
    ...(view.provenance.size === 0 ? {} : { provenance: view.provenance }),
    suppressed,
    suppressedOwn,
    foldable,
  });
  return { suppressedOwn, suppressed, foldable, pack };
}

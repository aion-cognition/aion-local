import type { MemoryPack } from '@aion/protocol';

import type { RestatedClaimPair } from '../../infrastructure/graph/near-duplicate-queries.js';
import type { FusedItem } from '../domain/fusion.js';
import { bucketFor } from '../domain/pack-buckets.js';
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
/**
 * What of a ranked set this session may be served, under one reading: the narrative
 * representation the family established, less what the session's own turns produced and what it
 * already holds unchanged. Serving takes it here, and the recall assessment takes it before the
 * model is asked, so the model is never shown a memory the pack would then withhold.
 */
export function servable(
  input: Pick<ServingAssembly, 'ranked' | 'served' | 'dedup'>,
  view: ResolvedEvidenceView,
): {
  readonly selected: readonly FusedItem[];
  readonly suppressedOwn: ReadonlySet<string>;
  readonly suppressed: ReadonlySet<string>;
} {
  const selected = input.ranked.filter((item) => {
    if (!item.labels.includes('Narrative') || view.narrativeFamilies === undefined) {
      return true;
    }
    const representation = view.narrativeFamilies.values.get(item.id);
    return representation?.selection === 'selected' && representation.publication === 'established';
  });
  const suppressedOwn = suppressedOwnSession({ items: selected, view });
  const suppressed = input.dedup
    ? suppressedRepeats(
        selected.filter((item) => !suppressedOwn.has(item.id)),
        input.served,
        view,
      )
    : new Set<string>();
  return { selected, suppressedOwn, suppressed };
}

export function serveFrom(
  input: ServingAssembly,
  view: ResolvedEvidenceView,
  onDecision?: (decision: PackDecision) => void,
): ServedAnswer {
  const { selected, suppressedOwn, suppressed } = servable(input, view);
  const selectedIds = new Set(selected.map((item) => item.id));
  for (const item of input.ranked) {
    if (!selectedIds.has(item.id)) {
      const primary = input.assembly.items.some((candidate) => candidate.id === item.id);
      const resonant =
        input.assembly.resonant?.some((candidate) => candidate.id === item.id) ?? false;
      let bucket: PackDecision['bucket'] = 'intentions';
      if (primary) {
        bucket = bucketFor(item.labels) ?? 'narratives';
      } else if (resonant) {
        bucket = 'resonant';
      }
      onDecision?.({
        id: item.id,
        bucket,
        reason: 'representation_family',
      });
    }
  }
  const foldable = foldableClaims({ items: selected, pairs: input.restated, view });
  const pack = assemblePack({
    ...input.assembly,
    items: input.assembly.items.filter((item) => selectedIds.has(item.id)),
    ...(input.assembly.resonant === undefined
      ? {}
      : { resonant: input.assembly.resonant.filter((item) => selectedIds.has(item.id)) }),
    ...(input.assembly.intentions === undefined
      ? {}
      : { intentions: input.assembly.intentions.filter((item) => selectedIds.has(item.id)) }),
    ...(onDecision === undefined ? {} : { onDecision }),
    ...(view.relatedClaims.size === 0 ? {} : { relatedClaims: view.relatedClaims }),
    ...(view.provenance.size === 0 ? {} : { provenance: view.provenance }),
    suppressed,
    suppressedOwn,
    foldable,
  });
  return { suppressedOwn, suppressed, foldable, pack };
}

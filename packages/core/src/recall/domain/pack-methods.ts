import type { MemoryPack } from '@aion/protocol';

import { PACK_BUCKETS } from './pack-buckets.js';

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

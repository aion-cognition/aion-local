import { describe, expect, it } from 'vitest';

import { redirectAndAbsorb } from './entity-merge-queries.js';
import { DedupFakeGraph } from '../../reflection/application/stages/entity-dedup.fixture.js';

/**
 * The merge's lock order, read off the fake's lock log. A deadlock needs a real server and two
 * transactions racing, and reproducing one on a schedule is luck rather than a test; what is
 * pinnable here is the property that rules the deadlock out. Two overlapping groups deadlock
 * only when they request the same two nodes in opposite orders, so the group is locked in one
 * sorted pass and the canonical takes no privileged position in it.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');

async function lockOrder(canonicalId: string, mergedIds: readonly string[]): Promise<string[]> {
  const graph = new DedupFakeGraph();
  for (const id of [canonicalId, ...mergedIds]) {
    graph.seedNode(id, ['Entity', 'AionNode'], { name: id, name_norm: id, type: 'concept' });
  }
  await redirectAndAbsorb(graph.driver, {
    canonicalId,
    canonicalNameNorm: canonicalId,
    mergedIds,
    aliases: [],
    accessCount: 0,
    now: NOW,
  });
  return graph.locked;
}

describe('the merge lock pass', () => {
  it('locks the whole group in sorted order whichever member is canonical', async () => {
    const sorted = ['entity-a', 'entity-m', 'entity-z'];
    expect(await lockOrder('entity-z', ['entity-a', 'entity-m'])).toEqual(sorted);
    expect(await lockOrder('entity-a', ['entity-m', 'entity-z'])).toEqual(sorted);
    expect(await lockOrder('entity-m', ['entity-a', 'entity-z'])).toEqual(sorted);
  });
});

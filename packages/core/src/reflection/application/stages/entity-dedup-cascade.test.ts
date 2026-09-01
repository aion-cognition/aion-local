import { describe, expect, it } from 'vitest';

import { orderNominations, type NominatedPair } from './entity-dedup-cascade.js';

/**
 * How a run spends a judge budget it cannot cover. Ranking one nominator above the other hands
 * every call to that nominator's top of list, which on names means the identifier-shaped traps:
 * two sha256 digests differing in the last byte are the highest name cosine any measured set has
 * produced, and the shared-episode nominations behind them never get asked about.
 */

function pair(left: string, right: string, signals: Partial<NominatedPair>): NominatedPair {
  return { leftId: left, rightId: right, ...signals };
}

function names(ordered: readonly NominatedPair[]): string[] {
  return ordered.map((entry) => entry.leftId);
}

describe('orderNominations', () => {
  it('alternates the two nominators rather than ranking one above the other', () => {
    const ordered = orderNominations([
      pair('cos-low', 'x', { nominatingCosine: 0.86 }),
      pair('cos-high', 'x', { nominatingCosine: 0.99 }),
      pair('jac-low', 'x', { sharedEpisodeJaccard: 0.3 }),
      pair('jac-high', 'x', { sharedEpisodeJaccard: 0.8 }),
    ]);

    expect(names(ordered)).toEqual(['cos-high', 'jac-high', 'cos-low', 'jac-low']);
  });

  it('leaves the graph nominations inside a budget the traps would have eaten whole', () => {
    const traps = [0.9868, 0.9656, 0.9137, 0.9021].map((cosine, index) =>
      pair(`trap-${String(index)}`, 'x', { nominatingCosine: cosine }),
    );
    const shared = [0.71, 0.66].map((jaccard, index) =>
      pair(`shared-${String(index)}`, 'x', { sharedEpisodeJaccard: jaccard }),
    );

    const budget = orderNominations([...traps, ...shared]).slice(0, 4);

    expect(names(budget)).toEqual(['trap-0', 'shared-0', 'trap-1', 'shared-1']);
  });

  it('emits a pair both nominators put forward once, at its first turn', () => {
    const ordered = orderNominations([
      pair('both', 'x', { nominatingCosine: 0.99, sharedEpisodeJaccard: 0.9 }),
      pair('vector-only', 'x', { nominatingCosine: 0.9 }),
      pair('graph-only', 'x', { sharedEpisodeJaccard: 0.5 }),
    ]);

    expect(names(ordered)).toEqual(['both', 'graph-only', 'vector-only']);
  });

  it('orders one nominator alone by strength, and ties by the pair key', () => {
    const ordered = orderNominations([
      pair('b', 'z', { sharedEpisodeJaccard: 0.5 }),
      pair('a', 'z', { sharedEpisodeJaccard: 0.5 }),
      pair('c', 'z', { sharedEpisodeJaccard: 0.9 }),
    ]);

    expect(names(ordered)).toEqual(['c', 'a', 'b']);
  });

  it('keeps every pair it was handed', () => {
    const pairs = [
      pair('one', 'x', { nominatingCosine: 0.9 }),
      pair('two', 'x', { sharedEpisodeJaccard: 0.4 }),
      pair('three', 'x', { nominatingCosine: 0.7, sharedEpisodeJaccard: 0.6 }),
    ];

    expect(orderNominations(pairs)).toHaveLength(pairs.length);
  });
});

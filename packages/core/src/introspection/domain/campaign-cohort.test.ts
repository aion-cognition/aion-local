import { describe, expect, it } from 'vitest';

import {
  partitionIsExhaustive,
  partitionStaleEdges,
  type ObservedEdgeState,
} from './campaign-cohort.js';

function stale(id: string): ObservedEdgeState {
  return { id, open: true, targetClosed: true };
}

function repaired(id: string): ObservedEdgeState {
  return { id, open: false, targetClosed: true };
}

describe('partitioning a frozen stale-edge cohort', () => {
  it('sorts each frozen edge into exactly one class that sums to the frozen count', () => {
    const partition = partitionStaleEdges({
      frozen: ['e1', 'e2', 'e3', 'e4'],
      observed: [stale('e1'), repaired('e2')],
      removalManifest: ['e3'],
    });

    expect(partition.counts).toEqual({
      still_open: 1,
      closed: 1,
      removed_by_verified_eviction: 1,
      unexplained_missing: 1,
    });
    expect(partition.denominator).toBe(4);
    expect(partitionIsExhaustive(partition)).toBe(true);
  });

  it('gives closure and verified removal different classes', () => {
    const partition = partitionStaleEdges({
      frozen: ['closed-one', 'evicted-one'],
      observed: [repaired('closed-one')],
      removalManifest: ['evicted-one'],
    });
    expect(partition.byClass.closed).toEqual(['closed-one']);
    expect(partition.byClass.removed_by_verified_eviction).toEqual(['evicted-one']);
  });

  it('flags an edge that vanished with no manifest naming it', () => {
    const partition = partitionStaleEdges({
      frozen: ['gone'],
      observed: [],
      removalManifest: [],
    });
    expect(partition.byClass.unexplained_missing).toEqual(['gone']);
  });

  it('counts an edge that became stale after the freeze separately', () => {
    const partition = partitionStaleEdges({
      frozen: ['e1'],
      observed: [stale('e1'), stale('later')],
      removalManifest: [],
    });
    expect(partition.newlyStale).toEqual(['later']);
    expect(partition.denominator).toBe(1);
  });

  it('leaves an open edge whose target still stands out of the new stale set', () => {
    const partition = partitionStaleEdges({
      frozen: [],
      observed: [{ id: 'healthy', open: true, targetClosed: false }],
      removalManifest: [],
    });
    expect(partition.newlyStale).toEqual([]);
  });

  it('flags a manifest that names an edge the graph still holds', () => {
    const partition = partitionStaleEdges({
      frozen: ['still-there'],
      observed: [stale('still-there')],
      removalManifest: ['still-there'],
    });
    expect(partition.manifestContradictions).toEqual(['still-there']);
    expect(partition.byClass.still_open).toEqual(['still-there']);
    expect(partition.byClass.removed_by_verified_eviction).toEqual([]);
  });

  it('reports a duplicated frozen id as a partition that does not add up', () => {
    const partition = partitionStaleEdges({
      frozen: ['dupe', 'dupe'],
      observed: [stale('dupe')],
      removalManifest: [],
    });
    expect(partitionIsExhaustive(partition)).toBe(false);
  });
});

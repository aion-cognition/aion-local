import { describe, expect, it } from 'vitest';

import { introspectionOperations } from './catalog.js';

/**
 * The operations whose runs no snapshot number can contradict yet, each named in the catalog's
 * own docstring beside the gauge it is waiting on. The list is here rather than derived so that
 * an operation gaining or losing a metric has to move a line a reader can see, and so the
 * docstring and the code cannot drift apart quietly.
 */
const UNMEASURED_OPERATIONS = [
  'claim_dedup',
  'community_refresh',
  'description_freshness',
  'memory_decay',
  'merge_decision_reconcile',
  'narrative_cleanup',
  'retro_judgment_sweep',
  'symbiosis_bridge',
];

describe('introspectionOperations', () => {
  it('registers every operation under a name of its own', () => {
    const names = introspectionOperations().map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('leaves exactly the surveyed operations without a declared metric', () => {
    const withoutMeasure = introspectionOperations()
      .filter((operation) => operation.measure === undefined)
      .map((operation) => operation.name)
      .sort();
    expect(withoutMeasure).toEqual(UNMEASURED_OPERATIONS);
  });
});

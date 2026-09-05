import { describe, expect, it } from 'vitest';

import { introspectionOperations } from './catalog.js';
import { TIER3_ACTABLE_OPERATIONS } from '../domain/tier3.js';

/**
 * The operations whose runs no snapshot number can contradict yet, each named in the catalog's
 * own docstring beside the gauge it is waiting on. The list is here rather than derived so that
 * an operation gaining or losing a metric has to move a line a reader can see, and so the
 * docstring and the code cannot drift apart quietly.
 */
const UNMEASURED_OPERATIONS = [
  'claim_consolidation',
  'claim_dedup',
  'community_refresh',
  'curiosity',
  'description_freshness',
  'intention_upkeep',
  'memory_decay',
  'merge_decision_reconcile',
  'narrative_cleanup',
  'narrative_rollup_day',
  'narrative_rollup_week',
  'proposal_resolution',
  'retro_judgment_sweep',
  'structural_discovery',
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

  it('registers every operation tier 3 is allowed to run', () => {
    // The allowlist holds bare strings. A rename that missed one would drop that operation out
    // of tier 3 silently, as a permanent `downgraded` verdict nobody asked for.
    const names = new Set(introspectionOperations().map((operation) => operation.name));
    const unregistered = TIER3_ACTABLE_OPERATIONS.filter((name) => !names.has(name));
    expect(unregistered).toEqual([]);
  });
});

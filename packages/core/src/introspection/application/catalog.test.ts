import { describe, expect, it } from 'vitest';

import { introspectionOperations } from './catalog.js';
import { EPISODE_EVICT_OPERATION } from './operations/episode-evict.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { TIER3_DENIED_OPERATIONS } from '../domain/tier3.js';

/** The shipped configuration, named at the call rather than reached for inside a relevance. */
const catalog = () => introspectionOperations(DEFAULTS);

/**
 * The operations whose runs no snapshot number can contradict yet, each named in the catalog's
 * own docstring beside the gauge it is waiting on. The list is here rather than derived so that
 * an operation gaining or losing a metric has to move a line a reader can see, and so the
 * docstring and the code cannot drift apart quietly.
 */
const UNMEASURED_OPERATIONS = [
  // Deliberate. The snapshot counts what the lane owes, but a run that finds every job still
  // working at the vendor moved nothing and did its job; what the runs are worth is the cost per
  // answer applied rather than a queue depth.
  'batch_settlement',
  'claim_consolidation',
  'claim_dedup',
  'community_refresh',
  // No snapshot counts an owed confirmation signal, and counting them would cost the same read
  // the repair itself takes.
  'confirmation_signal_completion',
  'curiosity',
  'description_freshness',
  // Deliberate, like `narrative_seal` below. What an eviction lowers is the resident population,
  // and an operation scored on lowering that is one rewarded for removing more of it.
  'episode_evict',
  'intention_upkeep',
  'memory_decay',
  'merge_decision_reconcile',
  'narrative_cleanup',
  // The metric it declared counted the legacy graph marker, which describes the family it is
  // leaving rather than the chunk population it now regrounds. Unmeasured until a baseline over
  // that population exists; the old count is not one.
  'narrative_regrounding',
  'narrative_rollup_day',
  'narrative_rollup_week',
  // Deliberate, not owed. The snapshot counts what the chunk lifecycle owes, and an operation
  // scored on lowering its own backlog is credited alike for a chunk it published and one it
  // blocked; what the runs are worth is a cost and coverage comparison, not a queue depth.
  'narrative_seal',
  // The disconnection share it used to move is a different number about a different
  // population now. Unmeasured until a replacement has been validated against the new demand.
  'orphan_cleanup',
  'proposal_resolution',
  'recall_probe',
  'retro_judgment_sweep',
  'structural_discovery',
  'symbiosis_bridge',
];

describe('introspectionOperations', () => {
  it('registers every operation under a name of its own', () => {
    const names = catalog().map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('leaves exactly the surveyed operations without a declared metric', () => {
    const withoutMeasure = catalog()
      .filter((operation) => operation.measure === undefined)
      .map((operation) => operation.name)
      .sort();
    expect(withoutMeasure).toEqual(UNMEASURED_OPERATIONS);
  });

  it('registers every operation tier 3 is denied', () => {
    // The denylist holds bare strings. A rename that missed one would silently hand a model the
    // one write nothing puts back, which is the opposite of the mistake the old allowlist made.
    const names = new Set(catalog().map((operation) => operation.name));
    const unregistered = TIER3_DENIED_OPERATIONS.filter((name) => !names.has(name));
    expect(unregistered).toEqual([]);
  });

  /**
   * The hard-delete exception. Eviction removes a source's raw projection and no command puts
   * the original text back, which is the property that keeps an operation off the strategic
   * tier: a run a model chose has to be a run its own record can later judge and a person can
   * reverse.
   */
  it('denies the one operation whose removal nothing reverses', () => {
    expect(catalog().map((operation) => operation.name)).toContain(EPISODE_EVICT_OPERATION);
    expect(TIER3_DENIED_OPERATIONS).toContain(EPISODE_EVICT_OPERATION);
  });
});

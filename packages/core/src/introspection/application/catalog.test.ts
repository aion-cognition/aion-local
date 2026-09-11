import { describe, expect, it } from 'vitest';

import { introspectionOperations } from './catalog.js';
import { NARRATIVE_SEAL_OPERATION } from './operations/narrative-seal.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { TIER3_ACTABLE_OPERATIONS } from '../domain/tier3.js';

/** The shipped configuration, named at the call rather than reached for inside a relevance. */
const catalog = () => introspectionOperations(DEFAULTS);

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

  it('registers every operation tier 3 is allowed to run', () => {
    // The allowlist holds bare strings. A rename that missed one would drop that operation out
    // of tier 3 silently, as a permanent `downgraded` verdict nobody asked for.
    const names = new Set(catalog().map((operation) => operation.name));
    const unregistered = TIER3_ACTABLE_OPERATIONS.filter((name) => !names.has(name));
    expect(unregistered).toEqual([]);
  });

  /**
   * A model may recommend a seal run and the loop will log it, and it may not authorize one. The
   * seal freezes a membership that never moves again and the publication it leads to writes a
   * narrative through the guard; neither is a decision a recommendation should reach, and the
   * ordinary tiers already select the operation on a demand reading taken from durable state.
   */
  it('keeps the chunk lifecycle out of what a model may run', () => {
    expect(catalog().map((operation) => operation.name)).toContain(NARRATIVE_SEAL_OPERATION);
    expect(TIER3_ACTABLE_OPERATIONS).not.toContain(NARRATIVE_SEAL_OPERATION);
  });
});

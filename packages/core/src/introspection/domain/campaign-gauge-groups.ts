import {
  unavailableGauge,
  type Gauge,
  type GaugeStamp,
  type GaugeUnavailableReason,
} from './campaign-gauges.js';

/**
 * The six groups a campaign report covers and the observations each one owes. The table is
 * declared rather than inferred from whatever a run managed to collect: a group that reports
 * four of its six observations and says nothing about the other two reads as a complete group,
 * and the gap only shows up when somebody compares two runs. Naming the full set makes an
 * uncollected observation a visible `not_collected` reading instead of an absence.
 *
 * Most of these observations have no producer yet. That is the point of the table: until the
 * schema behind one exists, the group still reports it, as unavailable with the reason.
 */

export const GAUGE_GROUPS = [
  'seal_demand',
  'eviction_demand',
  'recovery',
  'evidence_integrity',
  'work_preservation',
  'independent_outcomes',
] as const;

export type GaugeGroup = (typeof GAUGE_GROUPS)[number];

export const GAUGE_OBSERVATIONS: Readonly<Record<GaugeGroup, readonly string[]>> = {
  seal_demand: [
    'unassigned_verified_sources',
    'eligible_seal_groups',
    'oldest_eligible_age_ms',
    'pinned_sources',
    'blocked_sources',
    'raw_size_distribution',
    'rendered_size_distribution',
    'new_sources_per_synthesis',
  ],
  eviction_demand: [
    'eligible_sources',
    'oldest_eligible_age_ms',
    'pinned_by_readiness',
    'resident_sources',
    'retiring_sources',
    'evicted_sources',
    'projected_node_work',
    'projected_edge_work',
    'scheduled_batches',
    'completed_batches',
  ],
  recovery: [
    'pending_operation_sequence',
    'pending_operation_age_ms',
    'last_acknowledged_sequence',
    'residency_attempts',
    'rejected_attempts',
    'deferred_attempts',
    'mismatched_receipts',
    'retry_backoff_age_ms',
  ],
  evidence_integrity: [
    'verified_mappings',
    'unresolved_mappings',
    'source_availability',
    'part_availability',
    'lineage_completeness',
    'unresolved_references',
    'gaps_by_field',
    'published_revisions_with_gaps',
    'stale_dependencies',
  ],
  work_preservation: [
    'accepted_reference_versions',
    'acknowledged_reference_versions',
    'obligations_by_stage',
    'obligations_by_processing_generation',
    'queue_running',
    'queue_backoff',
    'queue_dead_letter',
    'oldest_outstanding_obligation_age_ms',
  ],
  independent_outcomes: [
    'inspectable_original_sources',
    'stale_edge_partition',
    'label_populations',
    'physical_node_count',
    'physical_relationship_count',
    'orphan_count',
    'entity_mention_distribution',
    'retained_node_state',
    'physical_removal_bytes',
    'vector_bytes',
    'recall_trace_latency_ms',
    'cost_by_surface',
    'unmeasured_pagecache_disk',
  ],
};

/** The observations a group owes that this run did not report. */
export function missingObservations(
  group: GaugeGroup,
  collected: Iterable<string>,
): readonly string[] {
  const held = new Set(collected);
  return GAUGE_OBSERVATIONS[group].filter((name) => !held.has(name));
}

/**
 * Every observation in a group, all unavailable for one reason. This is what a group reports
 * when the store behind it is missing or would not answer, and it is deliberately not an empty
 * map: a group with no entries reads as a group with no demand.
 */
export function unavailableGroup(
  group: GaugeGroup,
  reason: GaugeUnavailableReason,
  stamp: GaugeStamp,
): ReadonlyMap<string, Gauge> {
  return new Map(
    GAUGE_OBSERVATIONS[group].map((name) => [name, unavailableGauge(reason, stamp)] as const),
  );
}

/**
 * Fills the observations a group owes but this run never attempted, leaving what was collected
 * exactly as collected.
 */
export function withUncollected(
  group: GaugeGroup,
  collected: ReadonlyMap<string, Gauge>,
  stamp: GaugeStamp,
): ReadonlyMap<string, Gauge> {
  const complete = new Map(collected);
  for (const name of missingObservations(group, collected.keys())) {
    complete.set(name, unavailableGauge('not_collected', stamp));
  }
  return complete;
}

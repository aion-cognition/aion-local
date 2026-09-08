import { describe, expect, it } from 'vitest';

import {
  CoverageGapReasonSchema,
  CoverageGapSchema,
  CoverageRefusalReasonSchema,
  CoverageRefusalSchema,
  HISTORY_GAP_REASONS,
  HistoryCoverageSchema,
} from './history-coverage.js';
import { MemoryPackSchema } from './recall-output.js';

const H = '2026-09-08T02:00:00.000Z';

const baseMetadata = {
  token_estimate: 240,
  stage_timings_ms: { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 },
  cues: [{ text: 'webhooks', source: 'query', weight: 3 }],
  admission: {
    considered: 0,
    admitted: 0,
    dropped_below_floor: 0,
    dropped_unmeasured: 0,
    dropped_unmeasured_arrival: 0,
    dropped_duplicate_content: 0,
    dropped_near_duplicate: 0,
    vector_floor: 0.6,
    corroboration_floor: 0.45,
    bm25_mode: 'exact',
  },
};

describe('the coverage statement', () => {
  it('parses an active-contract temporal result carrying its boundary', () => {
    const coverage = {
      contract_version: 1,
      history_since: H,
      status: 'supported',
      knew_at: '2026-09-08T04:00:00.000Z',
      limitations: [],
      gaps: [],
    };

    expect(HistoryCoverageSchema.parse(coverage)).toEqual(coverage);
  });

  it('parses a preparing-contract result with no boundary and the contract limitation', () => {
    const coverage = {
      contract_version: 1,
      status: 'partial',
      knew_at: '2026-09-08T04:00:00.000Z',
      limitations: ['coverage_contract_not_active'],
      gaps: [],
    };

    expect(HistoryCoverageSchema.parse(coverage)).toEqual(coverage);
    expect(HistoryCoverageSchema.parse(coverage).history_since).toBeUndefined();
  });

  it('rejects a limitation or gap reason outside the closed vocabulary', () => {
    const coverage = { contract_version: 1, status: 'partial', limitations: [], gaps: [] };

    expect(HistoryCoverageSchema.safeParse({ ...coverage, limitations: ['maybe'] }).success).toBe(
      false,
    );
    expect(
      HistoryCoverageSchema.safeParse({
        ...coverage,
        gaps: [{ field: 'source_content', reason: 'felt_wrong' }],
      }).success,
    ).toBe(false);
    expect(
      CoverageGapSchema.safeParse({ field: 'not_a_field', reason: 'not_recorded' }).success,
    ).toBe(false);
  });

  it('carries the closed transport gap-reason set, historical causes included', () => {
    expect([...CoverageGapReasonSchema.options].sort()).toEqual(
      [
        'not_recorded',
        'unversioned_legacy',
        'erased_interval',
        'unresolved_mapping',
        'store_unavailable',
        'outside_field_policy',
        'pending_publication',
        'unverified_scope',
        'unresolved_reference',
        'bounded_read',
        'required_scope_missing',
      ].sort(),
    );
    expect(HISTORY_GAP_REASONS).toEqual([
      'not_recorded',
      'unversioned_legacy',
      'erased_interval',
      'outside_field_policy',
    ]);
  });

  it('names exactly four refusal reasons, and no inactive-contract reason among them', () => {
    expect([...CoverageRefusalReasonSchema.options].sort()).toEqual([
      'before_horizon',
      'coverage_changed',
      'coverage_store_unavailable',
      'future_knowledge',
    ]);
    expect(CoverageRefusalReasonSchema.safeParse('coverage_not_active').success).toBe(false);
  });

  it('carries what was asked and the bounds it was judged against', () => {
    const refusal = {
      contract_version: 1,
      reason: 'before_horizon',
      requested: { knew_at: '2026-01-01T00:00:00.000Z', now: '2026-09-08T06:00:00.000Z' },
      bounds: { history_since: H, coverage_state: 'active' },
    };

    expect(CoverageRefusalSchema.parse(refusal)).toEqual(refusal);
  });

  it('permits empty bounds, which is what an unreadable coverage record leaves known', () => {
    const refusal = {
      contract_version: 1,
      reason: 'coverage_store_unavailable',
      requested: { now: '2026-09-08T06:00:00.000Z' },
      bounds: {},
    };

    expect(CoverageRefusalSchema.parse(refusal)).toEqual(refusal);
  });
});

describe('the pack metadata field', () => {
  it('carries the coverage statement when a result has one', () => {
    const pack = {
      rendered_text: 'No relevant memories found.',
      metadata: {
        ...baseMetadata,
        history_coverage: {
          contract_version: 1,
          history_since: H,
          status: 'partial',
          limitations: [],
          gaps: [{ id: 'part:source-1:turn:0', field: 'source_clocks', reason: 'not_recorded' }],
        },
      },
    };

    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
  });

  it('leaves a pack written before the field existed parsing unchanged', () => {
    const pack = { rendered_text: 'No relevant memories found.', metadata: baseMetadata };

    expect(MemoryPackSchema.parse(pack)).toEqual(pack);
    expect(MemoryPackSchema.parse(pack).metadata.history_coverage).toBeUndefined();
  });
});

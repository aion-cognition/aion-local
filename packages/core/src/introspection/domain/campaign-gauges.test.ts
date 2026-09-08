import { describe, expect, it } from 'vitest';

import {
  GAUGE_GROUPS,
  GAUGE_OBSERVATIONS,
  missingObservations,
  unavailableGroup,
  withUncollected,
} from './campaign-gauge-groups.js';
import {
  intervalDelta,
  measuredGauge,
  unavailableGauge,
  type Gauge,
  type GaugeBasis,
  type GaugeStamp,
} from './campaign-gauges.js';

const LIVE: GaugeBasis = { population: 'live', denominator: 'open SUMMARIZED_BY edges' };
const FROZEN: GaugeBasis = {
  population: 'fixed_cohort',
  denominator: 'frozen stale edges',
  cohortId: 'cohort-1',
};

const STAMP: GaugeStamp = { sampledAt: '2026-09-07T00:00:00.000Z', basis: LIVE, metricVersion: 1 };

describe('the gauge envelope', () => {
  it('carries a real zero with its basis rather than reporting nothing', () => {
    expect(measuredGauge(0, 'edges', STAMP)).toEqual({
      status: 'measured',
      value: 0,
      unit: 'edges',
      sampledAt: STAMP.sampledAt,
      basis: LIVE,
      metricVersion: 1,
    });
  });

  it('separates a store that would not answer from a schema that is not there', () => {
    expect(unavailableGauge('not_installed', STAMP).reason).toBe('not_installed');
    expect(unavailableGauge('store_unavailable', STAMP).reason).toBe('store_unavailable');
  });
});

describe('interval deltas', () => {
  const previous = { sampleId: 's1', gauge: measuredGauge(10, 'edges', STAMP) };

  it('subtracts two readings taken on the same basis and metric version', () => {
    const current = { sampleId: 's2', gauge: measuredGauge(4, 'edges', STAMP) };
    expect(intervalDelta(previous, current)).toEqual({
      status: 'measured',
      value: -6,
      unit: 'edges',
      priorSampleId: 's1',
      sampleId: 's2',
    });
  });

  it('refuses to subtract across a metric version', () => {
    const current = {
      sampleId: 's2',
      gauge: measuredGauge(4, 'edges', { ...STAMP, metricVersion: 2 }),
    };
    expect(intervalDelta(previous, current)).toMatchObject({
      status: 'unavailable',
      reason: 'metric_version_changed',
    });
  });

  it('refuses to subtract across a changed population', () => {
    const current = {
      sampleId: 's2',
      gauge: measuredGauge(4, 'edges', { ...STAMP, basis: FROZEN }),
    };
    expect(intervalDelta(previous, current)).toMatchObject({
      status: 'unavailable',
      reason: 'basis_changed',
    });
  });

  it('refuses to subtract when either reading is unavailable', () => {
    const current = { sampleId: 's2', gauge: unavailableGauge('collector_failed', STAMP) };
    expect(intervalDelta(previous, current)).toMatchObject({
      status: 'unavailable',
      reason: 'sample_unavailable',
    });
  });
});

describe('gauge groups', () => {
  it('names an observation set for each of the six groups', () => {
    expect(GAUGE_GROUPS).toHaveLength(6);
    for (const group of GAUGE_GROUPS) {
      expect(GAUGE_OBSERVATIONS[group].length).toBeGreaterThan(0);
    }
  });

  it('reports every observation of a group as unavailable when its store is missing', () => {
    for (const group of GAUGE_GROUPS) {
      const gauges = unavailableGroup(group, 'not_installed', STAMP);
      expect(gauges.size).toBe(GAUGE_OBSERVATIONS[group].length);
      for (const gauge of gauges.values()) {
        expect(gauge).toMatchObject({ status: 'unavailable', reason: 'not_installed' });
      }
    }
  });

  it('lists what a partial collection still owes', () => {
    const collected = new Map<string, Gauge>([
      ['label_populations', measuredGauge(3, 'labels', STAMP)],
    ]);
    const missing = missingObservations('independent_outcomes', collected.keys());
    expect(missing).not.toContain('label_populations');
    expect(missing).toContain('orphan_count');
  });

  it('fills an unattempted observation rather than leaving the group short', () => {
    const collected = new Map<string, Gauge>([
      ['label_populations', measuredGauge(3, 'labels', STAMP)],
    ]);
    const complete = withUncollected('independent_outcomes', collected, STAMP);
    expect(complete.size).toBe(GAUGE_OBSERVATIONS.independent_outcomes.length);
    expect(complete.get('label_populations')).toMatchObject({ status: 'measured', value: 3 });
    expect(complete.get('orphan_count')).toMatchObject({
      status: 'unavailable',
      reason: 'not_collected',
    });
  });
});

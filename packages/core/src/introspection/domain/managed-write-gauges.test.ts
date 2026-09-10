import { describe, expect, it } from 'vitest';

import { GAUGE_OBSERVATIONS, withUncollected } from './campaign-gauge-groups.js';
import { intervalDelta, type Gauge } from './campaign-gauges.js';
import {
  MANAGED_WRITE_METRIC_VERSION,
  MANAGED_WRITE_OBSERVATIONS,
  managedWriteGauges,
} from './managed-write-gauges.js';
import type { ManagedWriteObservations } from '../../infrastructure/graph/managed-write-observations.js';

const SAMPLED_AT = '2026-09-09T00:00:00.000Z';

const ZERO: ManagedWriteObservations = {
  epoch: 'epoch-one',
  countsComplete: true,
  logicalOperations: 0,
  callbackAttempts: 0,
  callbackReplays: 0,
  replaysByClass: { deadlock: 0, other_transient: 0, outside_callback: 0, unknown: 0 },
  callbackFailures: 0,
  failuresByCode: {},
  failureCodesTruncated: false,
  callerFulfilments: 0,
  callerRejections: 0,
  observerFailures: 0,
};

function replayed(overrides: Partial<ManagedWriteObservations>): ManagedWriteObservations {
  return { ...ZERO, ...overrides };
}

function gaugeAt(gauges: ReadonlyMap<string, Gauge>, name: string): Gauge {
  const held = gauges.get(name);
  if (held === undefined) {
    throw new Error(`no gauge named ${name}`);
  }
  return held;
}

describe('managed write gauges', () => {
  it('reports the replay count with the population it was counted over', () => {
    const gauges = managedWriteGauges(
      replayed({
        logicalOperations: 16,
        callbackAttempts: 20,
        callbackReplays: 4,
        replaysByClass: { deadlock: 3, other_transient: 1, outside_callback: 0, unknown: 0 },
        callbackFailures: 4,
        callerFulfilments: 16,
      }),
      SAMPLED_AT,
    );

    const replays = gaugeAt(gauges, 'managed_write_callback_replays');
    expect(replays).toMatchObject({
      status: 'measured',
      value: 4,
      unit: 'invocations',
      sampledAt: SAMPLED_AT,
      metricVersion: MANAGED_WRITE_METRIC_VERSION,
      basis: { population: 'live', cohortId: 'epoch-one' },
    });
    expect(replays.basis.denominator).toContain('inWriteTransaction');
    expect(gaugeAt(gauges, 'managed_write_callback_replays_deadlock')).toMatchObject({
      status: 'measured',
      value: 3,
    });
    expect(gaugeAt(gauges, 'managed_write_caller_rejections')).toMatchObject({
      status: 'measured',
      value: 0,
      unit: 'calls',
    });
  });

  it('says which write paths it does not see', () => {
    const gauges = managedWriteGauges(ZERO, SAMPLED_AT);
    const { denominator } = gaugeAt(gauges, 'managed_write_callback_replays').basis;

    expect(denominator).toContain('executeQuery');
    expect(denominator).toContain('publication');
  });

  it('reports a run that replayed nothing as a measured zero', () => {
    const gauges = managedWriteGauges(
      replayed({ logicalOperations: 8, callerFulfilments: 8 }),
      SAMPLED_AT,
    );

    expect(gaugeAt(gauges, 'managed_write_callback_replays')).toMatchObject({
      status: 'measured',
      value: 0,
    });
    expect(gaugeAt(gauges, 'managed_write_logical_operations')).toMatchObject({
      status: 'measured',
      value: 8,
    });
  });

  it('returns every observation the group table declares for it', () => {
    const gauges = managedWriteGauges(ZERO, SAMPLED_AT);

    expect([...gauges.keys()]).toEqual([...MANAGED_WRITE_OBSERVATIONS]);
    for (const name of MANAGED_WRITE_OBSERVATIONS) {
      expect(GAUGE_OBSERVATIONS.independent_outcomes).toContain(name);
    }
  });

  it('refuses to subtract two samples taken from different accumulations', () => {
    const before = managedWriteGauges(replayed({ callbackReplays: 2 }), SAMPLED_AT);
    const after = managedWriteGauges(replayed({ callbackReplays: 5 }), SAMPLED_AT);
    const restarted = managedWriteGauges(
      replayed({ epoch: 'epoch-two', callbackReplays: 1 }),
      SAMPLED_AT,
    );

    expect(
      intervalDelta(
        { sampleId: 'first', gauge: gaugeAt(before, 'managed_write_callback_replays') },
        { sampleId: 'second', gauge: gaugeAt(after, 'managed_write_callback_replays') },
      ),
    ).toMatchObject({ status: 'measured', value: 3 });
    expect(
      intervalDelta(
        { sampleId: 'first', gauge: gaugeAt(before, 'managed_write_callback_replays') },
        { sampleId: 'third', gauge: gaugeAt(restarted, 'managed_write_callback_replays') },
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'basis_changed' });
  });

  it('publishes no count at all when the counts are not complete', () => {
    const gauges = managedWriteGauges(
      replayed({ countsComplete: false, callbackAttempts: 4, observerFailures: 1 }),
      SAMPLED_AT,
    );

    expect([...gauges.keys()]).toEqual([...MANAGED_WRITE_OBSERVATIONS]);
    for (const [, gauge] of gauges) {
      expect(gauge).toMatchObject({ status: 'unavailable', reason: 'collector_failed' });
    }
    expect(
      intervalDelta(
        { sampleId: 'first', gauge: gaugeAt(gauges, 'managed_write_callback_attempts') },
        { sampleId: 'second', gauge: gaugeAt(gauges, 'managed_write_callback_attempts') },
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'sample_unavailable' });
  });

  it('leaves a collector that cannot see the counter reporting uncollected', () => {
    const stamp = {
      sampledAt: SAMPLED_AT,
      basis: { population: 'live' as const, denominator: 'whole substrate' },
      metricVersion: 1,
    };

    const filled = withUncollected('independent_outcomes', new Map(), stamp);

    for (const name of MANAGED_WRITE_OBSERVATIONS) {
      expect(filled.get(name)).toMatchObject({ status: 'unavailable', reason: 'not_collected' });
    }
  });
});

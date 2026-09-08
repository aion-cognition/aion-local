/**
 * The measurement envelope every campaign observation is reported in.
 *
 * A number on its own cannot say whether it was taken. A table that does not exist yet, a
 * store that would not answer, and a genuine backlog of zero are three different facts, and
 * reporting all three as `0` turns a collector outage into a claim that there is no work to
 * do. So a reading is either measured with its unit and its basis, or unavailable with the
 * reason it is unavailable, and nothing in between.
 */

export const GAUGE_UNAVAILABLE_REASONS = [
  /** The producing schema is not installed yet, so there is nothing to read. */
  'not_installed',
  /** The store exists and would not answer. */
  'store_unavailable',
  /** The read ran and threw. */
  'collector_failed',
  /** This run did not attempt the observation. */
  'not_collected',
] as const;

export type GaugeUnavailableReason = (typeof GAUGE_UNAVAILABLE_REASONS)[number];

/**
 * Which population the value describes. A fixed cohort carries the manifest that froze it, so
 * two readings taken against different memberships cannot be subtracted from each other.
 */
export type GaugeBasis = {
  readonly population: 'fixed_cohort' | 'live';
  /** What the value counts over, in words: the exact denominator and predicate. */
  readonly denominator: string;
  readonly cohortId?: string;
};

export type MeasuredGauge = {
  readonly status: 'measured';
  readonly value: number;
  /** Named, because a byte count and a row count read the same at a glance. */
  readonly unit: string;
  readonly sampledAt: string;
  readonly basis: GaugeBasis;
  readonly metricVersion: number;
};

export type UnavailableGauge = {
  readonly status: 'unavailable';
  readonly reason: GaugeUnavailableReason;
  readonly sampledAt: string;
  readonly basis: GaugeBasis;
  readonly metricVersion: number;
};

export type Gauge = MeasuredGauge | UnavailableGauge;

export type GaugeStamp = {
  readonly sampledAt: string;
  readonly basis: GaugeBasis;
  readonly metricVersion: number;
};

export function measuredGauge(value: number, unit: string, stamp: GaugeStamp): MeasuredGauge {
  return { status: 'measured', value, unit, ...stamp };
}

export function unavailableGauge(
  reason: GaugeUnavailableReason,
  stamp: GaugeStamp,
): UnavailableGauge {
  return { status: 'unavailable', reason, ...stamp };
}

/** A reading and the identity of the sample it was taken in, which a delta cites. */
export type GaugeSample = {
  readonly sampleId: string;
  readonly gauge: Gauge;
};

export const GAUGE_DELTA_REFUSALS = [
  'sample_unavailable',
  'metric_version_changed',
  'basis_changed',
] as const;

export type GaugeDeltaRefusal = (typeof GAUGE_DELTA_REFUSALS)[number];

export type GaugeDelta =
  | {
      readonly status: 'measured';
      readonly value: number;
      readonly unit: string;
      readonly priorSampleId: string;
      readonly sampleId: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: GaugeDeltaRefusal;
      readonly priorSampleId: string;
      readonly sampleId: string;
    };

function sameBasis(left: GaugeBasis, right: GaugeBasis): boolean {
  return (
    left.population === right.population &&
    left.denominator === right.denominator &&
    left.cohortId === right.cohortId
  );
}

/**
 * The interval change between two samples of one observation, or a refusal to subtract them.
 * A metric version bump changes what the number means and a basis change moves the population
 * under it, so both cases report the refusal rather than a difference nobody can read.
 */
export function intervalDelta(previous: GaugeSample, current: GaugeSample): GaugeDelta {
  const cited = { priorSampleId: previous.sampleId, sampleId: current.sampleId };
  if (previous.gauge.status !== 'measured' || current.gauge.status !== 'measured') {
    return { status: 'unavailable', reason: 'sample_unavailable', ...cited };
  }
  if (previous.gauge.metricVersion !== current.gauge.metricVersion) {
    return { status: 'unavailable', reason: 'metric_version_changed', ...cited };
  }
  if (!sameBasis(previous.gauge.basis, current.gauge.basis)) {
    return { status: 'unavailable', reason: 'basis_changed', ...cited };
  }
  return {
    status: 'measured',
    value: current.gauge.value - previous.gauge.value,
    unit: current.gauge.unit,
    ...cited,
  };
}

import { describe, expect, it } from 'vitest';

import { PROBE_ACCEPTANCE_AGE_MS, sampleEligibility } from './probe-sample.js';
import type {
  AcceptedSourceSample,
  SourceReadiness,
} from '../../infrastructure/sqlite/probe-incidence.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function sample(overrides: Partial<AcceptedSourceSample> = {}): AcceptedSourceSample {
  return {
    sourceId: 'source-1',
    sessionId: 'session-1',
    acceptedAt: '2026-09-06T12:00:00.000Z',
    // Years old, which is exactly what must not qualify it on its own.
    occurredAt: '2019-01-01T00:00:00.000Z',
    verificationStatus: 'verified',
    ...overrides,
  };
}

const READY: SourceReadiness = { generation: 3, outstanding: 0, unfinishedStages: 0 };

describe('probe sample eligibility', () => {
  it('accepts a mature source whose required pass is finished', () => {
    expect(sampleEligibility(sample(), READY, NOW)).toEqual({
      status: 'eligible',
      acceptedAt: '2026-09-06T12:00:00.000Z',
    });
  });

  it('holds a newly accepted source back however old its world date is', () => {
    const fresh = sample({ acceptedAt: new Date(NOW.getTime() - 60_000).toISOString() });

    expect(sampleEligibility(fresh, READY, NOW)).toEqual({
      status: 'ineligible',
      reason: 'accepted_too_recently',
    });
  });

  it('ages on acceptance rather than on the capture clock', () => {
    const backdated = sample({
      acceptedAt: new Date(NOW.getTime() - PROBE_ACCEPTANCE_AGE_MS - 1).toISOString(),
      occurredAt: '2019-01-01T00:00:00.000Z',
    });

    expect(sampleEligibility(backdated, READY, NOW).status).toBe('eligible');
  });

  it('will not score a source whose acceptance proof is missing', () => {
    expect(sampleEligibility(sample({ verificationStatus: 'pinned' }), READY, NOW)).toEqual({
      status: 'ineligible',
      reason: 'unverified_acceptance',
    });
    expect(sampleEligibility(sample({ acceptedAt: 'not a date' }), READY, NOW)).toEqual({
      status: 'ineligible',
      reason: 'acceptance_clock_unreadable',
    });
  });

  it('will not score a source nothing has processed', () => {
    const none: SourceReadiness = { generation: undefined, outstanding: 0, unfinishedStages: 0 };

    expect(sampleEligibility(sample(), none, NOW)).toEqual({
      status: 'ineligible',
      reason: 'no_active_generation',
    });
  });

  it('will not score a source with work still owed, of any kind', () => {
    const owed: SourceReadiness = { generation: 3, outstanding: 1, unfinishedStages: 0 };
    const unfinished: SourceReadiness = { generation: 3, outstanding: 0, unfinishedStages: 1 };

    expect(sampleEligibility(sample(), owed, NOW)).toEqual({
      status: 'ineligible',
      reason: 'processing_incomplete',
    });
    expect(sampleEligibility(sample(), unfinished, NOW)).toEqual({
      status: 'ineligible',
      reason: 'processing_incomplete',
    });
  });
});

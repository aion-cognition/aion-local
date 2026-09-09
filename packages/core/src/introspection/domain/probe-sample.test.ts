import { describe, expect, it } from 'vitest';

import { PROBE_ACCEPTANCE_AGE_MS, sampleEligibility } from './probe-sample.js';
import type { AcceptedSourceSample } from '../../infrastructure/sqlite/probe-incidence.js';
import type { ProcessingReadiness } from '../../reflection/domain/readiness.js';

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

function readiness(overrides: Partial<ProcessingReadiness> = {}): ProcessingReadiness {
  return {
    sourceId: 'source-1',
    processingGeneration: 3,
    policyRevision: 1,
    inputDigest: 'digest',
    operationalRevision: 4,
    stages: [{ stageName: 'one', disposition: 'complete', reason: 'accepted_pass_applied' }],
    outstandingWorkIds: [],
    completeness: 'complete',
    reasons: [],
    ...overrides,
  };
}

const READY = readiness();

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
    const none = readiness({
      processingGeneration: undefined,
      policyRevision: undefined,
      inputDigest: undefined,
      operationalRevision: undefined,
      stages: [],
      completeness: 'unknown',
      reasons: ['no active processing generation'],
    });

    expect(sampleEligibility(sample(), none, NOW)).toEqual({
      status: 'ineligible',
      reason: 'no_active_generation',
      detail: ['no active processing generation'],
    });
  });

  it('will not score a source with work still owed, of any kind', () => {
    const owed = readiness({
      completeness: 'incomplete',
      outstandingWorkIds: ['stage:one'],
      reasons: ['stage:stage:one is pending'],
    });

    expect(sampleEligibility(sample(), owed, NOW)).toEqual({
      status: 'ineligible',
      reason: 'processing_incomplete',
      detail: ['stage:stage:one is pending'],
    });
  });

  /**
   * The reading the row-counting predicate could not make. A generation exists and a stage its
   * accepted policy required has no row at all, so the records cannot say what the pass was. That
   * is a different skip from work known to be owed, and reporting it as finished is what let an
   * unprocessed source into the sample.
   */
  it('will not score a source whose required stage has no row to read', () => {
    const unproved = readiness({
      stages: [
        { stageName: 'two', disposition: 'unrecorded', reason: 'no row for a required stage' },
      ],
      completeness: 'unknown',
      reasons: ['required stage two has no row'],
    });

    expect(sampleEligibility(sample(), unproved, NOW)).toEqual({
      status: 'ineligible',
      reason: 'processing_unproved',
      detail: ['required stage two has no row'],
    });
  });
});

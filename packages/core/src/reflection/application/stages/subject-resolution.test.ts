import { describe, expect, it } from 'vitest';

import { narrowClaimKey } from './subject-resolution.js';

/**
 * What the extractor's three key fields are worth per label, before any graph read. The subject
 * still has to resolve to an entity for a key to land; this is only which labels are allowed to
 * carry one at all.
 */

const FIELDS = {
  subjectEntity: 'Postgres',
  aspect: 'Queue Store',
  temporalClass: 'standing',
} as const;

describe('narrowClaimKey', () => {
  it('keys a fact-bearing claim on all three fields', () => {
    expect(narrowClaimKey('Decision', FIELDS)).toEqual({
      subject: 'Postgres',
      aspectNorm: 'queue store',
      temporalClass: 'standing',
    });
  });

  it('keys a goal and a plan on the subject and the aspect', () => {
    expect(narrowClaimKey('Goal', FIELDS)).toEqual({
      subject: 'Postgres',
      aspectNorm: 'queue store',
    });
    expect(narrowClaimKey('Plan', FIELDS)).toEqual({
      subject: 'Postgres',
      aspectNorm: 'queue store',
    });
  });

  it('drops the temporal class an intention carries, since its horizon is its own', () => {
    expect(narrowClaimKey('Goal', { ...FIELDS, temporalClass: 'reading' })).not.toHaveProperty(
      'temporalClass',
    );
  });

  it('keys nothing on a label that is neither a fact nor an intention', () => {
    expect(narrowClaimKey('Context', FIELDS)).toEqual({});
    expect(narrowClaimKey('Pattern', FIELDS)).toEqual({});
    expect(narrowClaimKey('Trend', FIELDS)).toEqual({});
  });

  it('declines the aspect an intention states as a sentence rather than an attribute', () => {
    const key = narrowClaimKey('Plan', {
      ...FIELDS,
      aspect: 'the store the reflection queue writes to now that it no longer shares a transaction',
    });

    expect(key.subject).toBe('Postgres');
    expect(key.aspectNorm).toBeUndefined();
  });
});

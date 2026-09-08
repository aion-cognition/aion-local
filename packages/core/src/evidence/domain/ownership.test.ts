import { describe, expect, it } from 'vitest';

import { ownershipEvidenceVersion, ownershipVerdict, type OwnershipSummary } from './ownership.js';

const COUNTED: OwnershipSummary = {
  sessions: ['session-a'],
  unknownAttribution: false,
  censusEstablished: true,
};

describe('the verdict one asking session draws from a stored summary', () => {
  it('reads a set holding only the asker as its own record', () => {
    expect(ownershipVerdict(COUNTED, 'session-a')).toBe('own_only');
  });

  it('reads a set holding anybody else as shared', () => {
    expect(
      ownershipVerdict({ ...COUNTED, sessions: ['session-a', 'session-b'] }, 'session-a'),
    ).toBe('shared');
    expect(ownershipVerdict(COUNTED, 'session-b')).toBe('shared');
  });

  /**
   * The same stored summary answers for every asker, which is the whole reason it stores a set
   * rather than a boolean about somebody else.
   */
  it('answers two different askers from one summary', () => {
    const shared: OwnershipSummary = { ...COUNTED, sessions: ['session-a', 'session-b'] };

    expect(ownershipVerdict(shared, 'session-a')).toBe('shared');
    expect(ownershipVerdict(shared, 'session-c')).toBe('shared');
    expect(ownershipVerdict({ ...COUNTED, sessions: ['session-c'] }, 'session-c')).toBe('own_only');
  });

  /**
   * Uncertainty keeps the memory eligible without asserting that anybody outside the session
   * wrote it, so it is its own answer rather than either of the other two.
   */
  it('answers unknown where a contribution has no session behind it', () => {
    expect(ownershipVerdict({ ...COUNTED, unknownAttribution: true }, 'session-a')).toBe('unknown');
  });

  it('answers unknown where the scopes behind the set were never counted', () => {
    expect(ownershipVerdict({ ...COUNTED, censusEstablished: false }, 'session-a')).toBe('unknown');
  });

  it('answers unknown where nothing carries the node at all', () => {
    expect(ownershipVerdict({ ...COUNTED, sessions: [] }, 'session-a')).toBe('unknown');
  });
});

describe('the stored version', () => {
  it('holds still while the derived answer holds still', () => {
    expect(ownershipEvidenceVersion(COUNTED)).toBe(ownershipEvidenceVersion({ ...COUNTED }));
  });

  it('moves when the session set moves', () => {
    expect(ownershipEvidenceVersion({ ...COUNTED, sessions: ['session-a', 'session-b'] })).not.toBe(
      ownershipEvidenceVersion(COUNTED),
    );
  });

  it('moves when attribution stops being certain', () => {
    expect(ownershipEvidenceVersion({ ...COUNTED, unknownAttribution: true })).not.toBe(
      ownershipEvidenceVersion(COUNTED),
    );
  });

  it('moves when the census behind it moves', () => {
    expect(ownershipEvidenceVersion({ ...COUNTED, censusEstablished: false })).not.toBe(
      ownershipEvidenceVersion(COUNTED),
    );
  });
});

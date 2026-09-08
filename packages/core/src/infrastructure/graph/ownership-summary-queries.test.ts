import { describe, expect, it } from 'vitest';

import {
  orderedPublicationSequence,
  ownOnlyDiscount,
  OWNERSHIP_PROPERTIES,
} from './ownership-summary-queries.js';

describe('the stored form of a publication sequence', () => {
  /**
   * Sequences run past the safe-integer range and Cypher compares the stored strings, so the
   * padding is what keeps 10 ahead of 9 instead of behind it.
   */
  it('orders the way the numbers order', () => {
    const ordered = ['0', '9', '10', '9007199254740993', '9223372036854775807'].map(
      orderedPublicationSequence,
    );

    expect([...ordered].sort()).toEqual(ordered);
    expect(orderedPublicationSequence('9') < orderedPublicationSequence('10')).toBe(true);
  });

  it('gives every sequence the same width', () => {
    expect(
      new Set(['0', '7', '12345678901234567'].map((v) => orderedPublicationSequence(v).length)),
    ).toEqual(new Set([20]));
  });

  it('refuses a value that is not a publication sequence', () => {
    expect(() => orderedPublicationSequence('-1')).toThrow();
    expect(() => orderedPublicationSequence('01')).toThrow();
  });
});

describe('the pre-limit discount predicate', () => {
  const predicate = ownOnlyDiscount('n');

  it('requires the pairing, the census, the bound and a set holding only the asker', () => {
    expect(predicate).toContain(`n.${OWNERSHIP_PROPERTIES.substrate} = $ownSubstrateId`);
    expect(predicate).toContain(`n.${OWNERSHIP_PROPERTIES.census} = true`);
    expect(predicate).toContain(`n.${OWNERSHIP_PROPERTIES.unknownAttribution} = false`);
    expect(predicate).toContain(`n.${OWNERSHIP_PROPERTIES.sequence} <= $ownAcknowledgedSequence`);
    expect(predicate).toContain(`$ownSessionId IN n.${OWNERSHIP_PROPERTIES.sessions}`);
    expect(predicate).toContain(
      `size([s IN n.${OWNERSHIP_PROPERTIES.sessions} WHERE s <> $ownSessionId]) = 0`,
    );
  });

  /**
   * Every clause is a conjunct. A missing summary, an unacknowledged one and a foreign pairing
   * all fail it, and failing it is what preserves the candidate.
   */
  it('joins every condition with AND and nothing else', () => {
    expect(predicate).not.toContain(' OR ');
    expect(predicate.startsWith('(') && predicate.endsWith(')')).toBe(true);
  });

  it('reads the node variable it was given', () => {
    expect(ownOnlyDiscount('candidate')).toContain(
      `candidate.${OWNERSHIP_PROPERTIES.substrate} = $ownSubstrateId`,
    );
  });
});

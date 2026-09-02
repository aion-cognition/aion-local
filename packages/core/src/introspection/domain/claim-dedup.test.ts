import { describe, expect, it } from 'vitest';

import { claimDedupPairKey, selectClaimDedupSurvivor } from './claim-dedup.js';

describe('claimDedupPairKey', () => {
  it('is the same key whichever side is named first', () => {
    expect(claimDedupPairKey('a', 'b')).toBe(claimDedupPairKey('b', 'a'));
  });

  it('differs for a different pair', () => {
    expect(claimDedupPairKey('a', 'b')).not.toBe(claimDedupPairKey('a', 'c'));
  });
});

describe('selectClaimDedupSurvivor', () => {
  it('keeps the older claim, whichever argument position it is passed in', () => {
    const older = { id: 'older', occurredAt: new Date('2026-01-01T00:00:00.000Z') };
    const newer = { id: 'newer', occurredAt: new Date('2026-06-01T00:00:00.000Z') };

    expect(selectClaimDedupSurvivor(older, newer)).toEqual({ survivor: older, loser: newer });
    expect(selectClaimDedupSurvivor(newer, older)).toEqual({ survivor: older, loser: newer });
  });

  it('breaks a tied occurred_at on id, deterministically either way round', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const a = { id: 'a', occurredAt: at };
    const b = { id: 'b', occurredAt: at };

    expect(selectClaimDedupSurvivor(a, b)).toEqual({ survivor: a, loser: b });
    expect(selectClaimDedupSurvivor(b, a)).toEqual({ survivor: a, loser: b });
  });
});

import { describe, expect, it } from 'vitest';
import { coOccurringPairs, coOccursLedgerKey } from './associations.js';

describe('coOccurringPairs', () => {
  it('pairs every distinct entity with every other exactly once', () => {
    const pairs = coOccurringPairs(['b', 'a', 'c']);

    expect(pairs).toEqual([
      { sourceId: 'a', targetId: 'b' },
      { sourceId: 'a', targetId: 'c' },
      { sourceId: 'b', targetId: 'c' },
    ]);
  });

  it('produces the same pairs regardless of input order', () => {
    const forward = coOccurringPairs(['x', 'y', 'z']);
    const shuffled = coOccurringPairs(['z', 'x', 'y']);

    expect(shuffled).toEqual(forward);
  });

  it('drops a repeated id rather than pairing an entity with itself', () => {
    expect(coOccurringPairs(['a', 'a', 'b'])).toEqual([{ sourceId: 'a', targetId: 'b' }]);
  });

  it('produces no pairs for zero or one entity', () => {
    expect(coOccurringPairs([])).toEqual([]);
    expect(coOccurringPairs(['solo'])).toEqual([]);
  });
});

describe('coOccursLedgerKey', () => {
  it('scopes the key to the episode, and to nothing finer', () => {
    const key = coOccursLedgerKey('episode-1');

    expect(key).toBe('association.co_occurs:episode-1');
    expect(coOccursLedgerKey('episode-2')).not.toBe(key);
  });

  it('is one row per episode however many entities the episode named', () => {
    const keys = new Set(coOccurringPairs(['a', 'b', 'c', 'd']).map(() => coOccursLedgerKey('e')));

    expect(keys.size).toBe(1);
  });
});

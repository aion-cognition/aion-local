import { describe, expect, it } from 'vitest';

import {
  entityMergeLedgerKey,
  groupDuplicates,
  mergeAccessCount,
  mergeAliases,
  mergeLastAccessed,
  selectCanonical,
  type DedupCandidate,
} from './entity-merge.js';

function candidate(overrides: Partial<DedupCandidate> & { id: string }): DedupCandidate {
  return {
    name: overrides.id,
    isStructural: false,
    mentionCount: 0,
    aliases: [],
    accessCount: 0,
    ...overrides,
  };
}

describe('groupDuplicates', () => {
  it('collapses a chain of pairs into one group by transitive closure', () => {
    const groups = groupDuplicates([
      { a: 'a', b: 'b' },
      { a: 'b', b: 'c' },
    ]);

    expect(groups).toHaveLength(1);
    expect(new Set(groups[0])).toEqual(new Set(['a', 'b', 'c']));
  });

  it('keeps unrelated pairs in separate groups', () => {
    const groups = groupDuplicates([
      { a: 'a', b: 'b' },
      { a: 'x', b: 'y' },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => new Set(group))).toEqual(
      expect.arrayContaining([new Set(['a', 'b']), new Set(['x', 'y'])]),
    );
  });

  it('returns nothing for an empty pair list', () => {
    expect(groupDuplicates([])).toEqual([]);
  });
});

describe('selectCanonical', () => {
  it('picks the structural member even when an organic member has more mentions', () => {
    const structural = candidate({ id: 's', isStructural: true, mentionCount: 1 });
    const organic = candidate({ id: 'o', mentionCount: 50 });

    expect(selectCanonical([organic, structural])).toBe(structural);
  });

  it('picks the higher mention count when neither member is structural', () => {
    const weak = candidate({ id: 'weak', mentionCount: 1 });
    const strong = candidate({ id: 'strong', mentionCount: 4 });

    expect(selectCanonical([weak, strong])).toBe(strong);
  });

  it('breaks a mention-count tie toward the earlier tx_from', () => {
    const older = candidate({
      id: 'older',
      mentionCount: 2,
      txFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = candidate({
      id: 'newer',
      mentionCount: 2,
      txFrom: new Date('2026-06-01T00:00:00Z'),
    });

    expect(selectCanonical([newer, older])).toBe(older);
  });

  it('breaks a full tie by id, so the choice is deterministic', () => {
    const first = candidate({ id: 'a-node' });
    const second = candidate({ id: 'b-node' });

    expect(selectCanonical([second, first])).toBe(first);
    expect(selectCanonical([first, second])).toBe(first);
  });
});

describe('mergeAliases', () => {
  it('folds every member name and prior alias in, minus the canonical name itself', () => {
    const canonical = candidate({ id: 'c', name: 'Aion', aliases: ['the substrate'] });
    const absorbed = candidate({ id: 'm', name: 'aion project', aliases: ['Aion'] });

    expect(mergeAliases('Aion', [canonical, absorbed])).toEqual(['aion project', 'the substrate']);
  });
});

describe('mergeAccessCount and mergeLastAccessed', () => {
  it('sums access counts across the whole group', () => {
    const members = [
      candidate({ id: 'a', accessCount: 2 }),
      candidate({ id: 'b', accessCount: 5 }),
    ];
    expect(mergeAccessCount(members)).toBe(7);
  });

  it('keeps the most recent last_accessed across the group', () => {
    const earlier = candidate({ id: 'a', lastAccessed: new Date('2026-01-01T00:00:00Z') });
    const later = candidate({ id: 'b', lastAccessed: new Date('2026-02-01T00:00:00Z') });
    expect(mergeLastAccessed([earlier, later])).toEqual(later.lastAccessed);
  });

  it('returns undefined when nothing in the group has ever been accessed', () => {
    expect(mergeLastAccessed([candidate({ id: 'a' })])).toBeUndefined();
  });
});

describe('entityMergeLedgerKey', () => {
  it('sorts and dedupes the merged ids so discovery order cannot change the key', () => {
    expect(entityMergeLedgerKey('cascade-1', 'canonical', ['b', 'a', 'b'])).toBe(
      'entity.merge:cascade-1:canonical:a,b',
    );
  });

  it('gives one group a key per cascade version, so a re-decision reaches its own record', () => {
    expect(entityMergeLedgerKey('cascade-2', 'canonical', ['a'])).not.toBe(
      entityMergeLedgerKey('cascade-1', 'canonical', ['a']),
    );
  });
});

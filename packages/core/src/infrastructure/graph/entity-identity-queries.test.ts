import { describe, expect, it } from 'vitest';

import { aliasKeys, aliasRecord, MAX_STORED_ENTITY_ALIASES } from './entity-identity-queries.js';
import { foldName } from '../../reflection/domain/name-fold.js';

function spellings(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `spelling ${String(index).padStart(2, '0')}`);
}

describe('the alias record', () => {
  it('keeps one entry per spelling and never the identity own name', () => {
    expect(aliasRecord([' Postgres ', 'postgres', 'PostgreSQL'], 'postgres')).toEqual([
      'PostgreSQL',
    ]);
    expect(aliasKeys(['PostgreSQL', 'Postgres'], 'postgres')).toEqual(['postgresql']);
  });

  it('caps the list, because every entry is a lookup key and a line of the embedded name text', () => {
    const many = spellings(MAX_STORED_ENTITY_ALIASES + 6);

    expect(aliasRecord(many, 'postgres')).toHaveLength(MAX_STORED_ENTITY_ALIASES);
    expect(aliasKeys(many, 'postgres')).toHaveLength(MAX_STORED_ENTITY_ALIASES);
    // Sorted before the cut, so one set of spellings always survives to the same list.
    expect(aliasRecord(many, 'postgres')[0]).toBe('spelling 00');
  });

  it('keeps one spelling per lookup key, so neither list outruns the other', () => {
    const oneKey = ['Blue Team', 'blue team'];

    expect(aliasRecord(oneKey, 'postgres')).toHaveLength(aliasKeys(oneKey, 'postgres').length);
  });

  it('cuts both lists at the same entries, so a kept spelling carries the key that routes it', () => {
    // `Zulu` sorts ahead of every `spelling NN` as a surface form and behind every one of them
    // as a key, so two independent cuts at the cap keep two different sets.
    const overflowing = ['Zulu', ...spellings(MAX_STORED_ENTITY_ALIASES)];

    expect(aliasRecord(overflowing, 'postgres').map((alias) => foldName(alias))).toEqual(
      aliasKeys(overflowing, 'postgres'),
    );
  });
});

import { describe, expect, it } from 'vitest';

import { aliasKeys, aliasRecord, MAX_STORED_ENTITY_ALIASES } from './entity-identity-queries.js';

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
});

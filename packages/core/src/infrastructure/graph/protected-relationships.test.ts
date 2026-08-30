import { describe, expect, it } from 'vitest';

import {
  PROTECTED_RELATIONSHIP_TYPES,
  isProtectedRelationshipType,
} from './protected-relationships.js';
import { RELATIONSHIP_TYPES, isRelationshipType } from './relationships.js';

describe('protected relationship set', () => {
  it('names every type plasticity leaves alone', () => {
    expect([...PROTECTED_RELATIONSHIP_TYPES].sort()).toEqual(
      [
        'DERIVES_FROM',
        'EXTRACTED_FROM',
        'FOLLOWS',
        'HAS_MEMBER',
        'HAS_WORKSPACE',
        'INITIATED_BY',
        'PARTICIPATES_IN',
        'SUMMARIZED_BY',
        'SUPERSEDES',
        'WITHIN_WORKSPACE',
      ].sort(),
    );
  });

  it('lists only types the catalog actually declares', () => {
    for (const type of PROTECTED_RELATIONSHIP_TYPES) {
      expect(isRelationshipType(type)).toBe(true);
    }
  });

  it('leaves the association and observation types unprotected', () => {
    for (const type of ['CO_OCCURS', 'SIMILAR', 'RELATED_TO', 'MENTIONS', 'CAUSES']) {
      expect(isProtectedRelationshipType(type)).toBe(false);
    }
  });

  it('protects nothing outside the pinned list', () => {
    const unprotected = RELATIONSHIP_TYPES.filter((type) => !isProtectedRelationshipType(type));
    expect(unprotected.length).toBe(
      RELATIONSHIP_TYPES.length - PROTECTED_RELATIONSHIP_TYPES.length,
    );
  });

  it('reports an unknown type as unprotected rather than throwing', () => {
    expect(isProtectedRelationshipType('NOT_A_TYPE')).toBe(false);
  });
});

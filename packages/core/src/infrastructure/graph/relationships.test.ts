import { describe, expect, it } from 'vitest';

import {
  DIRECTED_RELATIONSHIP_TYPES,
  isRelationshipType,
  isUndirectedRelationshipType,
  normalizeEndpoints,
  UNDIRECTED_RELATIONSHIP_TYPES,
} from './relationships.js';

const ID_SAMPLES = ['a', 'b', 'm', 'z', '0', '9', 'aa', 'ab'];

describe('normalizeEndpoints', () => {
  it('is order-independent for every undirected type', () => {
    for (const type of UNDIRECTED_RELATIONSHIP_TYPES) {
      for (const left of ID_SAMPLES) {
        for (const right of ID_SAMPLES) {
          const forward = normalizeEndpoints(type, { sourceId: left, targetId: right });
          const reverse = normalizeEndpoints(type, { sourceId: right, targetId: left });
          expect(forward).toEqual(reverse);
          expect(forward.sourceId <= forward.targetId).toBe(true);
        }
      }
    }
  });

  it('is idempotent', () => {
    for (const type of UNDIRECTED_RELATIONSHIP_TYPES) {
      const once = normalizeEndpoints(type, { sourceId: 'z', targetId: 'a' });
      expect(normalizeEndpoints(type, once)).toEqual(once);
    }
  });

  it('preserves direction for every directed type', () => {
    for (const type of DIRECTED_RELATIONSHIP_TYPES) {
      expect(normalizeEndpoints(type, { sourceId: 'z', targetId: 'a' })).toEqual({
        sourceId: 'z',
        targetId: 'a',
      });
    }
  });
});

describe('catalog', () => {
  it('classifies the four undirected types and nothing else', () => {
    for (const type of UNDIRECTED_RELATIONSHIP_TYPES) {
      expect(isUndirectedRelationshipType(type)).toBe(true);
    }
    for (const type of DIRECTED_RELATIONSHIP_TYPES) {
      expect(isUndirectedRelationshipType(type)).toBe(false);
    }
  });

  it('rejects unknown types', () => {
    expect(isRelationshipType('MENTIONS')).toBe(true);
    expect(isRelationshipType('DROP_DATABASE')).toBe(false);
  });
});

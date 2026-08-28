import { describe, expect, it } from 'vitest';
import neo4j from 'neo4j-driver';
import {
  coerceGraphValue,
  fromGraphDateTime,
  fromGraphVector,
  toGraphDateTime,
  toGraphParameters,
  toGraphVector,
} from './values.js';

describe('coerceGraphValue', () => {
  it('unwraps lossless integers', () => {
    expect(coerceGraphValue(neo4j.int(42))).toBe(42);
  });

  it('unwraps temporal values to JS dates at the same instant', () => {
    const instant = new Date('2026-06-07T08:09:10.000Z');
    expect(coerceGraphValue(toGraphDateTime(instant))).toEqual(instant);
  });

  it('recurses through lists and maps returned by pattern comprehensions', () => {
    const instant = new Date('2026-06-07T08:09:10.000Z');
    expect(
      coerceGraphValue([{ id: 'x', at: toGraphDateTime(instant), count: neo4j.int(3) }]),
    ).toEqual([{ id: 'x', at: instant, count: 3 }]);
  });

  it('turns absent values into null rather than leaving undefined in a row', () => {
    expect(coerceGraphValue(undefined)).toBeNull();
    expect(coerceGraphValue(null)).toBeNull();
  });
});

describe('toGraphParameters', () => {
  it('drops undefined instead of writing a property removal', () => {
    expect(toGraphParameters({ a: 'kept', b: undefined })).toEqual({ a: 'kept' });
  });

  it('converts dates and copies readonly arrays', () => {
    const source: readonly string[] = ['a', 'b'];
    const converted = toGraphParameters({ at: new Date('2026-01-01T00:00:00.000Z'), list: source });
    expect(converted.at).not.toBeInstanceOf(Date);
    expect(converted.list).toEqual(['a', 'b']);
    expect(converted.list).not.toBe(source);
  });
});

describe('vectors', () => {
  it('sends embeddings as a plain float list, which is what the vector index accepts', () => {
    const stored = toGraphVector([0.1, 0.2, 0.3]);
    expect(Array.isArray(stored)).toBe(true);
    expect(fromGraphVector(stored)).toEqual([0.1, 0.2, 0.3]);
  });

  it('reads a driver-native vector back as numbers if one ever arrives', () => {
    expect(fromGraphVector(neo4j.vector(new Float32Array([1, 0])))).toEqual([1, 0]);
  });

  it('returns undefined for anything that is not a numeric list', () => {
    expect(fromGraphVector('nope')).toBeUndefined();
    expect(fromGraphVector(['a'])).toBeUndefined();
  });
});

describe('fromGraphDateTime', () => {
  it('round-trips a date and rejects a non-temporal value', () => {
    const instant = new Date('2026-06-07T08:09:10.000Z');
    expect(fromGraphDateTime(toGraphDateTime(instant))).toEqual(instant);
    expect(fromGraphDateTime('2026-06-07')).toBeUndefined();
  });
});

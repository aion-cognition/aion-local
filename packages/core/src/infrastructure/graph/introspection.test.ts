import { describe, expect, it } from 'vitest';
import { VectorIndexDimensionMismatchError, VectorIndexMissingError } from './errors.js';
import { assertVectorIndexDimensions, VECTOR_INDEX_NAMES, type VectorIndexInfo } from './introspection.js';

function indexes(dimension: number): VectorIndexInfo[] {
  return VECTOR_INDEX_NAMES.map((name) => ({ name, dimensions: dimension, similarityFunction: 'cosine' }));
}

describe('assertVectorIndexDimensions', () => {
  it('accepts indexes built at the embedding model dimension', () => {
    expect(() => assertVectorIndexDimensions(indexes(768), 768, 'nomic-embed-text')).not.toThrow();
  });

  it('names the index and both dimensions on a mismatch', () => {
    try {
      assertVectorIndexDimensions(indexes(768), 1024, 'mxbai-embed-large');
      expect.unreachable('expected a mismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(VectorIndexDimensionMismatchError);
      const mismatch = err as VectorIndexDimensionMismatchError;
      expect(mismatch.indexName).toBe('content_vec_idx');
      expect(mismatch.indexDimension).toBe(768);
      expect(mismatch.expectedDimension).toBe(1024);
      expect(mismatch.message).toContain('mxbai-embed-large');
    }
  });

  it('reports a missing index separately from a mis-dimensioned one', () => {
    const partial = indexes(768).filter((index) => index.name === 'content_vec_idx');

    expect(() => assertVectorIndexDimensions(partial, 768, 'nomic-embed-text')).toThrow(VectorIndexMissingError);
  });

  it('does not judge an index whose dimension the server did not report', () => {
    const unreported = VECTOR_INDEX_NAMES.map((name) => ({ name }));

    expect(() => assertVectorIndexDimensions(unreported, 768, 'nomic-embed-text')).not.toThrow();
  });
});

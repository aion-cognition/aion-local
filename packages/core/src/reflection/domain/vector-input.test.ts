import { describe, expect, it } from 'vitest';

import { entityNameVectorText, vectorInputHash } from './vector-input.js';

describe('vectorInputHash', () => {
  it('answers the same digest for the same text and a different one for any change', () => {
    expect(vectorInputHash('aion')).toBe(vectorInputHash('aion'));
    expect(vectorInputHash('aion')).not.toBe(vectorInputHash('aion\nthe substrate'));
  });

  it('is a sha256 hex digest, which is what the graph property holds', () => {
    expect(vectorInputHash('aion')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('entityNameVectorText', () => {
  it('embeds the folded name alone when the identity answers to nothing else', () => {
    expect(entityNameVectorText('aion', [])).toBe('aion');
  });

  it('puts every alias in the embedded text, so a nickname is inside the nominating vector', () => {
    expect(entityNameVectorText('postgres', ['postgresql', 'pg'])).toBe('postgres\npg\npostgresql');
  });

  it('drops an alias that repeats the identity own name, which is already the first line', () => {
    expect(entityNameVectorText('postgres', ['postgres'])).toBe(
      entityNameVectorText('postgres', []),
    );
  });

  it('sorts and deduplicates, so one alias set is always one hash whatever order it arrived in', () => {
    expect(entityNameVectorText('postgres', ['pg', 'postgresql', 'pg'])).toBe(
      entityNameVectorText('postgres', ['postgresql', 'pg']),
    );
  });
});

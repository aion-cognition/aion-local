import { describe, expect, it } from 'vitest';

import { embedQueryPrefix, maxEmbedInputChars } from './embed-models.js';
import { DEFAULTS } from '../config/defaults.js';

describe('embed input cap', () => {
  it('gives each model a cap under its own context window', () => {
    expect(maxEmbedInputChars('nomic-embed-text')).toBe(2046);
    expect(maxEmbedInputChars('snowflake-arctic-embed2')).toBe(8190);
  });

  it('reads the cap through the tag a pulled model carries', () => {
    expect(maxEmbedInputChars('snowflake-arctic-embed2:latest')).toBe(8190);
    expect(maxEmbedInputChars('nomic-embed-text:v1.5')).toBe(2046);
  });

  it('holds an unlisted model to the smallest measured window', () => {
    expect(maxEmbedInputChars('some-model-nobody-measured')).toBe(2046);
  });

  it('caps the configured default, so no model runs uncapped', () => {
    expect(maxEmbedInputChars(DEFAULTS.models.embed)).toBeGreaterThan(0);
  });
});

describe('query prefix', () => {
  it('marks a query for a model trained on asymmetric retrieval', () => {
    expect(embedQueryPrefix('snowflake-arctic-embed2')).toBe('query: ');
    expect(embedQueryPrefix('snowflake-arctic-embed2:latest')).toBe('query: ');
  });

  it('leaves nomic-embed-text unprefixed, which is what its floors were measured against', () => {
    expect(embedQueryPrefix('nomic-embed-text')).toBe('');
  });

  it('leaves an unlisted model unprefixed', () => {
    expect(embedQueryPrefix('some-model-nobody-measured')).toBe('');
  });
});

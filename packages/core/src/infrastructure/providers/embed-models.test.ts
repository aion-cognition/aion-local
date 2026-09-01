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
  /**
   * One row decides the spelling for every query-shaped embed: recall's cue batch, `aion
   * search`, `aion forget`, the doctor's field check and the committed calibrations. The
   * spelling and the floors are one decision, so a row that disagrees with the harness is a
   * runtime measuring against numbers nobody took for it.
   */
  it('spells a query the way the committed floors were measured', () => {
    expect(embedQueryPrefix('snowflake-arctic-embed2')).toBe('');
    expect(embedQueryPrefix('snowflake-arctic-embed2:latest')).toBe('');
  });

  it('leaves nomic-embed-text unprefixed, which is what its floors were measured against', () => {
    expect(embedQueryPrefix('nomic-embed-text')).toBe('');
  });

  it('leaves an unlisted model unprefixed', () => {
    expect(embedQueryPrefix('some-model-nobody-measured')).toBe('');
  });
});

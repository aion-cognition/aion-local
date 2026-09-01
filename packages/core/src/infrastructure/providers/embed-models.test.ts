import { describe, expect, it } from 'vitest';

import { embedQueryPrefix, maxEmbedInputChars, QUERY_PREFIX_SEAM_MODEL } from './embed-models.js';
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
    // The number, not a floor: the shipped default and the row it reads have to stay the same
    // decision, and an unlisted default silently caps at 2046 instead.
    expect(DEFAULTS.models.embed).toBe('snowflake-arctic-embed2');
    expect(maxEmbedInputChars(DEFAULTS.models.embed)).toBe(8190);
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

  /**
   * Every measured row is empty, so `${prefix}${text}` at the five call sites sends exactly what
   * a build with the composition deleted would send. The seam row is the one prefix any test can
   * see, and it carries the string arctic2 ships because that is the string Phase 4.4 decides on.
   */
  it('hands back a real prefix for the seam row the call-site tests compose with', () => {
    expect(embedQueryPrefix(QUERY_PREFIX_SEAM_MODEL)).toBe('query: ');
  });

  it('keeps the seam out of the models this install can be configured onto', () => {
    expect(QUERY_PREFIX_SEAM_MODEL).not.toBe(DEFAULTS.models.embed);
    expect(embedQueryPrefix(DEFAULTS.models.embed)).toBe('');
  });
});

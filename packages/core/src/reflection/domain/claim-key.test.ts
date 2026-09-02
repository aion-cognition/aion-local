import { describe, expect, it } from 'vitest';

import {
  MAX_ASPECT_LENGTH,
  foldAspect,
  isTemporalClass,
  readingHorizon,
  KEYED_CLOSE_METHOD,
  KEYED_CLOSE_SIGNALS,
} from './claim-key.js';

describe('isTemporalClass', () => {
  it('accepts the three classes a claim can carry', () => {
    expect(isTemporalClass('reading')).toBe(true);
    expect(isTemporalClass('standing')).toBe(true);
    expect(isTemporalClass('trend')).toBe(true);
  });

  it('rejects a fourth class rather than passing it through', () => {
    expect(isTemporalClass('permanent')).toBe(false);
    expect(isTemporalClass('Reading')).toBe(false);
    expect(isTemporalClass('')).toBe(false);
  });

  it('rejects a value that is not a string at all', () => {
    expect(isTemporalClass(undefined)).toBe(false);
    expect(isTemporalClass(null)).toBe(false);
    expect(isTemporalClass(3)).toBe(false);
    expect(isTemporalClass(['reading'])).toBe(false);
  });
});

describe('foldAspect', () => {
  it('folds case, so one attribute named two ways keys the same', () => {
    expect(foldAspect('Supersede Mode')).toBe('supersede mode');
    expect(foldAspect('SUPERSEDE MODE')).toBe(foldAspect('supersede mode'));
  });

  it('reduces compatibility spellings to their canonical form', () => {
    expect(foldAspect('ＳＵＰＥＲＳＥＤＥ ＭＯＤＥ')).toBe('supersede mode');
    expect(foldAspect('ﬁle limit')).toBe('file limit');
  });

  it('trims and collapses whitespace, including the spaces NFKC produces', () => {
    expect(foldAspect('  retry   count ')).toBe('retry count');
    expect(foldAspect('retry　count')).toBe('retry count');
  });

  it('declines an aspect that folds to nothing', () => {
    expect(foldAspect('')).toBeUndefined();
    expect(foldAspect('   ')).toBeUndefined();
    expect(foldAspect('　\n\t')).toBeUndefined();
  });

  it('declines a fold longer than the cap and keeps one exactly at it', () => {
    expect(foldAspect('a'.repeat(MAX_ASPECT_LENGTH))).toBe('a'.repeat(MAX_ASPECT_LENGTH));
    expect(foldAspect('a'.repeat(MAX_ASPECT_LENGTH + 1))).toBeUndefined();
  });

  it('measures the cap on the fold rather than on the raw aspect', () => {
    const padded = `  ${'a'.repeat(MAX_ASPECT_LENGTH)}  `;
    expect(padded.length).toBeGreaterThan(MAX_ASPECT_LENGTH);
    expect(foldAspect(padded)).toBe('a'.repeat(MAX_ASPECT_LENGTH));
  });
});

describe('readingHorizon', () => {
  it('counts forward from the episode clock, never from the wall clock', () => {
    const occurredAt = new Date('2024-03-01T08:30:00.000Z');

    expect(readingHorizon(occurredAt, 30)).toEqual(new Date('2024-03-31T08:30:00.000Z'));
  });

  it('carries the time of day across a month and a year boundary', () => {
    expect(readingHorizon(new Date('2026-12-20T23:15:00.000Z'), 30)).toEqual(
      new Date('2027-01-19T23:15:00.000Z'),
    );
  });

  it('leaves the episode clock it was handed unchanged', () => {
    const occurredAt = new Date('2026-09-01T00:00:00.000Z');

    readingHorizon(occurredAt, 30);

    expect(occurredAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('answers the same horizon for the same episode however often it is asked', () => {
    const occurredAt = new Date('2026-09-01T00:00:00.000Z');

    expect(readingHorizon(occurredAt, 7)).toEqual(readingHorizon(occurredAt, 7));
  });
});

describe('keyed close provenance', () => {
  it('names the path that closed the claim and the evidence it closed on', () => {
    expect(KEYED_CLOSE_METHOD).toBe('keyed_close');
    expect(KEYED_CLOSE_SIGNALS).toEqual(['subject_key']);
  });
});

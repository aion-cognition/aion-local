import { describe, expect, it } from 'vitest';
import { foldName } from '../../infrastructure/providers/unicode-fold.js';
import {
  MIN_OVERLAP_NAME_LENGTH,
  NAME_FORM_OVERLAP_THRESHOLD,
  nameFormMatches,
  nameFormOverlap,
} from './entity-identity.js';

/**
 * The pairs are the ones the P3 exercise measured, with its own cosines noted: a single vector
 * threshold separated none of them, which is why the name form is a second, independent leg.
 */
describe('nameFormMatches', () => {
  it.each([
    ['Aion', 'Aion Project'],
    ['Postgres', 'PostgreSQL'],
    ['Sarah Chen', 'Chen'],
    ['Valkey', 'Valkey Server'],
    ['Ryan Huber', 'Ryan H'],
  ])('accepts %s against %s', (a, b) => {
    expect(nameFormMatches(a, b)).toBe(true);
  });

  it.each([
    // cosine 0.9109, merged in the live product and collapsed two different credentials
    ['github-token', 'gitlab-token'],
    ['Redis', 'Redix'],
    // cosine 1.0000: the embedding model's constant vector for out-of-vocabulary classes
    ['Zoë Müller', 'José Álvarez'],
    ['naïve', 'café'],
    ['🌊', '🛰'],
    // cosine 0.849, a parent project and its own sub-component
    ['remittance reconciliation service', 'remittance ingest'],
    ['Project Helios', 'QUASARFLANGE7741'],
  ])('refuses %s against %s', (a, b) => {
    expect(nameFormMatches(a, b)).toBe(false);
  });

  it('refuses names that differ only in their digits', () => {
    expect(nameFormOverlap(foldName('beta episode 1'), foldName('beta episode 2'))).toBeGreaterThan(
      NAME_FORM_OVERLAP_THRESHOLD,
    );
    expect(nameFormMatches('beta episode 1', 'beta episode 2')).toBe(false);
    expect(nameFormMatches('P4', 'P5')).toBe(false);
  });

  it('lets a digit through when both names carry it', () => {
    expect(nameFormMatches('qwen3:8b', 'the qwen3:8b model')).toBe(true);
  });

  it('accepts an exact match through the fold, whatever the surface spelling', () => {
    expect(nameFormMatches('  POSTGRES ', 'postgres')).toBe(true);
    expect(nameFormMatches('Straße', 'STRASSE')).toBe(true);
  });

  it('holds a name too short for the overlap rule to an exact match', () => {
    expect(foldName('api').length).toBeLessThan(MIN_OVERLAP_NAME_LENGTH);
    expect(nameFormMatches('api', 'rapid')).toBe(false);
    expect(nameFormMatches('API', 'api')).toBe(true);
  });

  it('refuses an empty name rather than matching everything', () => {
    expect(nameFormMatches('', 'anything')).toBe(false);
    expect(nameFormMatches('   ', '')).toBe(false);
  });
});

describe('nameFormOverlap', () => {
  it('scores a contained name against its container at 1', () => {
    expect(nameFormOverlap('aion', 'aion project')).toBe(1);
  });

  it('keeps a one-character difference below the threshold', () => {
    expect(nameFormOverlap('redis', 'redix')).toBeLessThan(NAME_FORM_OVERLAP_THRESHOLD);
  });

  it('scores a name with no shared characters at 0', () => {
    expect(nameFormOverlap('kubernetes', '🌊')).toBe(0);
  });
});

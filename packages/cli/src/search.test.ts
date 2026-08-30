import type { Seed } from '@aion/core';
import { describe, expect, it } from 'vitest';

import { parseSearchFlags, renderSearchResults } from './search.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseSearchFlags', () => {
  it('reads a plain query with no flags', () => {
    expect(parseSearchFlags(['webhooks ingestion'])).toEqual({
      query: 'webhooks ingestion',
      json: false,
    });
  });

  it('joins an unquoted multi-word query back into one string', () => {
    expect(parseSearchFlags(['webhooks', 'ingestion'])).toEqual({
      query: 'webhooks ingestion',
      json: false,
    });
  });

  it('reads --json and --as-of/--knew-at as ISO timestamps', () => {
    const flags = parseSearchFlags(['ingestion', '--as-of', '2026-06-01T00:00:00.000Z', '--json']);
    expect(flags.query).toBe('ingestion');
    expect(flags.json).toBe(true);
    expect(flags.asOf).toEqual(new Date('2026-06-01T00:00:00.000Z'));
  });

  it('reads both --as-of and --knew-at together', () => {
    const flags = parseSearchFlags([
      'ingestion',
      '--as-of',
      '2026-06-01T00:00:00.000Z',
      '--knew-at',
      '2026-06-02T00:00:00.000Z',
    ]);
    expect(flags.asOf).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(flags.knewAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));
  });

  it('rejects a missing query, an unknown option, a missing value, or a bad timestamp', () => {
    expect(() => parseSearchFlags([])).toThrow('search needs a query');
    expect(() => parseSearchFlags(['q', '--bogus'])).toThrow(
      "unknown option '--bogus' for search (supported: --as-of, --knew-at, --json)",
    );
    expect(() => parseSearchFlags(['q', '--as-of'])).toThrow('--as-of needs a value');
    expect(() => parseSearchFlags(['q', '--as-of', 'not-a-date'])).toThrow(
      "--as-of got 'not-a-date', expected an ISO timestamp",
    );
  });
});

function seed(overrides: Partial<Seed> = {}): Seed {
  return {
    id: 'node-1',
    labels: ['Episode', 'Memory'],
    content: 'we picked webhooks for ingestion because polling was too slow',
    currency: 'current',
    score: 0.842,
    relevance: 0.842,
    provenance: [{ strategy: 'vector', score: 0.842, relevance: 0.842, cue: 'webhooks ingestion' }],
    ...overrides,
  };
}

describe('renderSearchResults', () => {
  it('says so when nothing matched', () => {
    const { lines, write } = collector();

    renderSearchResults([], write);

    expect(lines).toEqual(['no matches']);
  });

  it('renders id, label, score, and method per row', () => {
    const { lines, write } = collector();

    renderSearchResults([seed()], write);

    const text = lines.join('\n');
    expect(text).toContain('0.842');
    expect(text).toContain('vector');
    expect(text).toContain('Episode');
    expect(text).toContain('node-1');
    expect(text).toContain('we picked webhooks for ingestion');
  });

  it('truncates a long content preview', () => {
    const { lines, write } = collector();
    const long = 'x'.repeat(200);

    renderSearchResults([seed({ content: long })], write);

    const text = lines.join('\n');
    expect(text).toContain('…');
    expect(text).not.toContain(long);
  });
});

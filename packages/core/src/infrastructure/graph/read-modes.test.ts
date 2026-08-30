import { describe, expect, it } from 'vitest';

import { GraphWriteError } from './errors.js';
import {
  asOf,
  bitemporalAt,
  isTimeTravel,
  knewAt,
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
} from './read-modes.js';
import { fromGraphDateTime } from './values.js';

const VALID_AT = new Date('2026-03-01T00:00:00.000Z');
const KNOWN_AT = new Date('2026-04-01T00:00:00.000Z');

describe('withCurrency', () => {
  it('suppresses only forgotten rows, so superseded knowledge stays eligible', () => {
    const fragment = readModeFragment(withCurrency(), 'n');
    expect(fragment.where).toBe('n.forgotten_at IS NULL');
    expect(fragment.where).not.toContain('valid_until');
    expect(fragment.where).not.toContain('tx_until');
  });

  it('annotates currency against the current clock and projects the SUPERSEDES lineage', () => {
    const fragment = readModeFragment(withCurrency(), 'n');
    expect(fragment.currency).toBe(
      "CASE WHEN n.valid_until IS NULL OR n.valid_until > $rm_reference THEN 'current' ELSE 'superseded' END",
    );
    expect(fragment.lineage).toBe(
      'head([ (rm_sup)-[rm_sup_rel:SUPERSEDES]->(n) | { id: rm_sup.id, at: rm_sup_rel.created_at } ])',
    );
    expect(fragment.projection).toBe(
      `${fragment.currency} AS currency, ${fragment.lineage} AS superseded_by`,
    );
  });
});

describe('asOf', () => {
  it('slices world time and stops suppressing forgotten rows', () => {
    const fragment = readModeFragment(asOf(VALID_AT), 'n');
    expect(fragment.where).toBe(
      '(n.valid_from <= $rm_reference AND (n.valid_until IS NULL OR n.valid_until > $rm_reference))',
    );
    expect(fragment.where).not.toContain('forgotten_at');
  });

  it('marks the row that held then as current-for-then', () => {
    const fragment = readModeFragment(asOf(VALID_AT), 'n');
    expect(fragment.currency).toContain('$rm_reference');
    expect(fromGraphDateTime(fragment.parameters.rm_reference)).toEqual(VALID_AT);
  });

  it('keeps the whole lineage, since a later supersession is world knowledge', () => {
    expect(readModeFragment(asOf(VALID_AT), 'n').lineage).not.toContain('WHERE');
  });
});

describe('knewAt', () => {
  it('slices system time', () => {
    const fragment = readModeFragment(knewAt(KNOWN_AT), 'n');
    expect(fragment.where).toBe(
      '(n.tx_from <= $rm_known_at AND (n.tx_until IS NULL OR n.tx_until > $rm_known_at))',
    );
    expect(fromGraphDateTime(fragment.parameters.rm_known_at)).toEqual(KNOWN_AT);
  });

  it('judges currency against the knowledge time rather than the wall clock', () => {
    const fragment = readModeFragment(knewAt(KNOWN_AT), 'n');
    expect(fromGraphDateTime(fragment.parameters.rm_reference)).toEqual(KNOWN_AT);
  });

  it('reports only the lineage the substrate had recorded by then', () => {
    const fragment = readModeFragment(knewAt(KNOWN_AT), 'n');
    expect(fragment.lineage).toContain('WHERE rm_sup_rel.created_at <= $rm_known_at');
  });
});

describe('composition', () => {
  it('ANDs both timelines when a bitemporal point is pinned', () => {
    const fragment = readModeFragment(bitemporalAt(VALID_AT, KNOWN_AT), 'n');
    expect(fragment.where).toContain('n.valid_from <= $rm_reference');
    expect(fragment.where).toContain('n.tx_from <= $rm_known_at');
    expect(fragment.where).toContain(' AND ');
  });

  it('judges currency by world time when both timelines are pinned', () => {
    const fragment = readModeFragment(bitemporalAt(VALID_AT, KNOWN_AT), 'n');
    expect(fromGraphDateTime(fragment.parameters.rm_reference)).toEqual(VALID_AT);
  });

  it('namespaces parameters and comprehension variables so two fragments coexist', () => {
    const seed = readModeFragment(asOf(VALID_AT), 'seed', 'a');
    const neighbour = readModeFragment(knewAt(KNOWN_AT), 'nb', 'b');
    expect(Object.keys(seed.parameters).sort()).toEqual(['a_reference']);
    expect(Object.keys(neighbour.parameters).sort()).toEqual(['b_known_at', 'b_reference']);
    expect(seed.lineage).toContain('(a_sup)-[a_sup_rel:SUPERSEDES]->(seed)');
    expect(neighbour.lineage).toContain('(b_sup)-[b_sup_rel:SUPERSEDES]->(nb)');
  });

  it('reports whether a mode is a time-travel read', () => {
    expect(isTimeTravel(withCurrency())).toBe(false);
    expect(isTimeTravel(asOf(VALID_AT))).toBe(true);
    expect(isTimeTravel(knewAt(KNOWN_AT))).toBe(true);
  });

  it('refuses anything but a plain identifier for the node variable or prefix', () => {
    expect(() => readModeFragment(withCurrency(), 'n) DETACH')).toThrow(GraphWriteError);
    expect(() => readModeFragment(withCurrency(), 'n', 'x$y')).toThrow(GraphWriteError);
  });
});

describe('readCurrencyAnnotation', () => {
  it('reads a current row with no lineage', () => {
    expect(readCurrencyAnnotation({ currency: 'current', superseded_by: null })).toEqual({
      currency: 'current',
    });
  });

  it('reads a superseded row with its lineage', () => {
    const at = new Date('2026-05-05T00:00:00.000Z');
    expect(
      readCurrencyAnnotation({ currency: 'superseded', superseded_by: { id: 'new-1', at } }),
    ).toEqual({ currency: 'superseded', supersededBy: { id: 'new-1', at } });
  });

  it('falls back to current when the projection is absent or malformed', () => {
    expect(readCurrencyAnnotation({})).toEqual({ currency: 'current' });
    expect(readCurrencyAnnotation({ currency: 'current', superseded_by: { id: 7 } })).toEqual({
      currency: 'current',
    });
  });
});

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
const REFERENCE = new Date('2025-05-06T07:08:09.000Z');

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
      "CASE WHEN n.valid_until IS NOT NULL AND n.valid_until <= $rm_reference THEN 'superseded'" +
        " WHEN n.valid_horizon IS NOT NULL AND n.valid_horizon <= $rm_reference THEN 'expired'" +
        " ELSE 'current' END",
    );
    expect(fragment.lineage).toBe(
      'head([ (rm_sup)-[rm_sup_rel:SUPERSEDES]->(n) WHERE rm_sup_rel.tx_until IS NULL' +
        ' | { id: rm_sup.id, at: rm_sup_rel.created_at } ])',
    );
    expect(fragment.projection).toBe(
      `${fragment.currency} AS currency, ${fragment.lineage} AS superseded_by`,
    );
  });
});

describe('a reading past its horizon', () => {
  it('annotates the row expired and leaves it in the row set', () => {
    const fragment = readModeFragment(withCurrency(REFERENCE), 'n');
    expect(fragment.currency).toContain(
      "WHEN n.valid_horizon IS NOT NULL AND n.valid_horizon <= $rm_reference THEN 'expired'",
    );
    expect(fragment.where).toBe('n.forgotten_at IS NULL');
    expect(fragment.where).not.toContain('valid_horizon');
  });

  /**
   * A closed claim and an aged-out reading are different answers, and the close is the one a
   * successor can be named for, so it is asked first.
   */
  it('reports a superseded reading as superseded rather than as expired', () => {
    const fragment = readModeFragment(withCurrency(REFERENCE), 'n');
    const superseded = fragment.currency.indexOf("THEN 'superseded'");
    const expired = fragment.currency.indexOf("THEN 'expired'");
    expect(superseded).toBeGreaterThan(-1);
    expect(expired).toBeGreaterThan(superseded);
  });

  it('judges the horizon against the vantage point the rest of the read judges from', () => {
    const fragment = readModeFragment(asOf(VALID_AT), 'n');
    expect(fragment.currency).toContain('n.valid_horizon <= $rm_reference');
    expect(fromGraphDateTime(fragment.parameters.rm_reference)).toEqual(VALID_AT);
  });

  it('drops the expiry arm entirely when the annotation is switched off', () => {
    const fragment = readModeFragment({ reference: REFERENCE, expiryAnnotation: false }, 'n');
    expect(fragment.currency).toBe(
      'CASE WHEN n.valid_until IS NOT NULL AND n.valid_until <= $rm_reference' +
        " THEN 'superseded' ELSE 'current' END",
    );
    expect(fragment.currency).not.toContain('valid_horizon');
  });

  it('stays out of time travel with the annotation switched off', () => {
    expect(isTimeTravel({ reference: REFERENCE, expiryAnnotation: false })).toBe(false);
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

  /**
   * A world-time slice pins world time only, so the lineage question is still answered from
   * now: a supersession the substrate has since reopened is one it no longer holds.
   */
  it('keeps every supersession the substrate still holds, whenever it was recorded', () => {
    const { lineage } = readModeFragment(asOf(VALID_AT), 'n');
    expect(lineage).toContain('WHERE rm_sup_rel.tx_until IS NULL');
    expect(lineage).not.toContain('created_at <=');
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

  it('reports only the lineage the substrate had recorded by then, and still held then', () => {
    const fragment = readModeFragment(knewAt(KNOWN_AT), 'n');
    expect(fragment.lineage).toContain('WHERE rm_sup_rel.created_at <= $rm_known_at');
    expect(fragment.lineage).toContain(
      'AND (rm_sup_rel.tx_until IS NULL OR rm_sup_rel.tx_until > $rm_known_at)',
    );
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

  it('judges currency against the reference the caller passed rather than the wall clock', () => {
    const fragment = readModeFragment(withCurrency(REFERENCE), 'n');
    expect(fromGraphDateTime(fragment.parameters.rm_reference)).toEqual(REFERENCE);
    expect(fragment.currency).toContain('$rm_reference');
  });

  /**
   * A reference moves the currency judgment and nothing else: the row set a default read
   * returns is the same one, so a replay reading on the episode's clock still sees every
   * unforgotten row.
   */
  it('keeps a referenced read out of time travel and off the temporal predicates', () => {
    expect(isTimeTravel(withCurrency(REFERENCE))).toBe(false);
    expect(readModeFragment(withCurrency(REFERENCE), 'n').where).toBe('n.forgotten_at IS NULL');
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

  /** Nothing superseded an aged-out reading, so there is no successor for it to name. */
  it('reads an expired row, which has no lineage to report', () => {
    expect(readCurrencyAnnotation({ currency: 'expired', superseded_by: null })).toEqual({
      currency: 'expired',
    });
  });

  it('falls back to current when the projection is absent or malformed', () => {
    expect(readCurrencyAnnotation({})).toEqual({ currency: 'current' });
    expect(readCurrencyAnnotation({ currency: 'current', superseded_by: { id: 7 } })).toEqual({
      currency: 'current',
    });
    expect(readCurrencyAnnotation({ currency: 'stale' })).toEqual({ currency: 'current' });
  });
});

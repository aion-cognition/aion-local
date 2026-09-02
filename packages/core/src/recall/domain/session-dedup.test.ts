import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { servedFingerprint, suppressedRepeats } from './session-dedup.js';

type ItemOverrides = {
  readonly content?: string;
  readonly why?: string;
  readonly superseded?: boolean;
  readonly expired?: boolean;
  readonly rank?: number;
  readonly measured?: number;
};

function currencyOf(id: string, overrides: ItemOverrides): Partial<FusedItem> {
  if (overrides.superseded === true) {
    return {
      currency: 'superseded',
      supersededBy: { id: `${id}-successor`, at: new Date('2026-08-10T00:00:00.000Z') },
    };
  }
  return { currency: overrides.expired === true ? 'expired' : 'current' };
}

function item(id: string, overrides: ItemOverrides = {}): FusedItem {
  return {
    id,
    labels: ['Episode', 'Memory', 'AionNode'],
    content: overrides.content ?? `content of ${id}`,
    rationale: { method: 'vector', score: overrides.rank ?? 0.8 },
    relevance: 0.8,
    measured: overrides.measured ?? 0.8,
    score: 0.02,
    ...(overrides.why === undefined ? {} : { why: overrides.why }),
    currency: 'current',
    ...currencyOf(id, overrides),
  };
}

/** The record a session carries after the first serve of the items handed over. */
function served(...items: readonly FusedItem[]): ReadonlyMap<string, string> {
  return new Map(items.map((entry) => [entry.id, servedFingerprint(entry)]));
}

describe('the served fingerprint', () => {
  it('moves when the content the agent read changes', () => {
    expect(servedFingerprint(item('e1', { content: 'first' }))).not.toBe(
      servedFingerprint(item('e1', { content: 'second' })),
    );
  });

  it('moves when the memory is superseded, which the rendered line says out loud', () => {
    expect(servedFingerprint(item('e1'))).not.toBe(
      servedFingerprint(item('e1', { superseded: true })),
    );
  });

  /**
   * The reading the session already read now says it has aged out, and the rendered line says
   * so. That marker is new to the reader, so the item is told again in full rather than
   * subtracted as a repeat of what it said before.
   */
  it('moves when a reading crosses its horizon, which the rendered line also says', () => {
    const current = item('c1');

    expect(servedFingerprint(item('c1', { expired: true }))).not.toBe(servedFingerprint(current));
    expect([...suppressedRepeats([item('c1', { expired: true })], served(current))]).toEqual([]);
  });

  it("moves when the node's own stated reason changes", () => {
    expect(servedFingerprint(item('d1', { why: 'the old reason' }))).not.toBe(
      servedFingerprint(item('d1', { why: 'the reason it was rewritten to' })),
    );
  });

  /**
   * Rank and score are properties of the query, not of the memory. Folding them in would make
   * every reworded prompt look like the whole substrate had changed, which is the failure this
   * subtraction exists to stop.
   */
  it('holds still when only the query moved the item up the list', () => {
    expect(servedFingerprint(item('e1', { rank: 0.4, measured: 0.62 }))).toBe(
      servedFingerprint(item('e1', { rank: 0.9, measured: 0.91 })),
    );
  });
});

describe('suppressing what a session already holds', () => {
  it('suppresses an item served earlier that says the same thing now', () => {
    const stored = item('e1');

    expect([...suppressedRepeats([stored], served(stored))]).toEqual(['e1']);
  });

  it('serves an item this session has never seen', () => {
    expect([...suppressedRepeats([item('e2')], served(item('e1')))]).toEqual([]);
  });

  it('serves a changed item again in full rather than treating it as known', () => {
    const first = item('e1', { content: 'polling was too slow' });
    const regrown = item('e1', { content: 'polling was too slow, so ingestion moved to webhooks' });

    expect([...suppressedRepeats([regrown], served(first))]).toEqual([]);
  });

  it('serves a memory again once it has been superseded', () => {
    const current = item('e1');

    expect([...suppressedRepeats([item('e1', { superseded: true })], served(current))]).toEqual([]);
  });

  it('cuts only the repeats out of a mixed set', () => {
    const known = item('e1');
    const changed = item('e2');

    const suppressed = suppressedRepeats(
      [known, item('e2', { content: 'rewritten since' }), item('e3')],
      served(known, changed),
    );

    expect([...suppressed]).toEqual(['e1']);
  });

  /**
   * The one shape both exemptions take. A time-traveled read and a disabled knob both hand
   * over an empty record, so neither can subtract anything from the pack.
   */
  it('suppresses nothing when the session has no record to match against', () => {
    expect([...suppressedRepeats([item('e1'), item('e2')], new Map())]).toEqual([]);
  });
});

import type { RelatedClaim } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { suppressedOwnSession } from './session-origin.js';
import type { ItemOrigin } from '../../infrastructure/graph/origin-queries.js';

type ItemOverrides = {
  readonly labels?: readonly string[];
  readonly content?: string;
  readonly superseded?: boolean;
  readonly expired?: boolean;
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
    labels: overrides.labels ?? ['Insight', 'Memory', 'AionNode'],
    content: overrides.content ?? `content of ${id}`,
    rationale: { method: 'vector', score: 0.8 },
    relevance: 0.8,
    measured: 0.8,
    score: 0.02,
    currency: 'current',
    ...currencyOf(id, overrides),
  };
}

const OWN: ItemOrigin = { own: true, other: false };
const SHARED: ItemOrigin = { own: true, other: true };
const THEIRS: ItemOrigin = { own: false, other: true };
const UNATTRIBUTED: ItemOrigin = { own: false, other: false };

function origins(entries: Readonly<Record<string, ItemOrigin>>): ReadonlyMap<string, ItemOrigin> {
  return new Map(Object.entries(entries));
}

const NO_CLAIMS: ReadonlyMap<string, RelatedClaim> = new Map();

function suppress(
  items: readonly FusedItem[],
  resolved: ReadonlyMap<string, ItemOrigin>,
  relatedClaims: ReadonlyMap<string, RelatedClaim> = NO_CLAIMS,
): readonly string[] {
  return [...suppressedOwnSession({ items, origins: resolved, relatedClaims })];
}

describe('memories a session made out of its own turns', () => {
  it('withholds a claim whose only source is this session', () => {
    expect(suppress([item('c1')], origins({ c1: OWN }))).toEqual(['c1']);
  });

  it('serves a memory another session produced', () => {
    expect(suppress([item('c1')], origins({ c1: THEIRS }))).toEqual([]);
  });

  it('serves a memory this session and another both produced', () => {
    expect(suppress([item('c1')], origins({ c1: SHARED }))).toEqual([]);
  });

  it('serves a memory nothing attributes to any session', () => {
    expect(suppress([item('c1')], origins({ c1: UNATTRIBUTED }))).toEqual([]);
  });

  it('cuts only the session own memories out of a mixed set', () => {
    const items = [item('c1'), item('c2'), item('c3')];

    expect(suppress(items, origins({ c1: OWN, c2: THEIRS, c3: OWN }))).toEqual(['c1', 'c3']);
  });

  /**
   * An entity outlives every episode that named it and its description accretes from all of
   * them, so a second session mentioning it makes it shared knowledge rather than an echo. The
   * origin read is what resolves that, by asking which sessions mention the node rather than
   * which one wrote it first.
   */
  it('serves an entity a second session has also mentioned', () => {
    const entity = item('e1', { labels: ['Entity', 'Memory', 'AionNode'] });

    expect(suppress([entity], origins({ e1: SHARED }))).toEqual([]);
  });

  it('withholds an entity no other session has ever mentioned', () => {
    const entity = item('e1', { labels: ['Entity', 'Memory', 'AionNode'] });

    expect(suppress([entity], origins({ e1: OWN }))).toEqual(['e1']);
  });
});

/**
 * The session said it, and the graph has since said otherwise. That correction is the part the
 * conversation does not hold, so the item goes out in full and carries the marker with it.
 */
describe('a memory the substrate corrected after the session stored it', () => {
  it('serves a superseded claim the session itself produced', () => {
    expect(suppress([item('c1', { superseded: true })], origins({ c1: OWN }))).toEqual([]);
  });

  /**
   * A horizon is a clock running out, not the graph answering back. The session still holds
   * every word of the claim it made, and an older reading of its own is not news to it.
   */
  it('still withholds a claim of its own that has aged past its horizon', () => {
    expect(suppress([item('c1', { expired: true })], origins({ c1: OWN }))).toEqual(['c1']);
  });

  it('serves a turn resonance found a current claim beside', () => {
    const turn = item('t1', { labels: ['Turn', 'Memory', 'AionNode'] });
    const claims = new Map([['t1', { id: 'c9', text: 'polling came back' }]]);

    expect(suppress([turn], origins({ t1: OWN }), claims)).toEqual([]);
  });

  it('still withholds the turns beside it that nothing has contradicted', () => {
    const items = [item('t1', { labels: ['Turn'] }), item('t2', { labels: ['Turn'] })];
    const claims = new Map([['t1', { id: 'c9', text: 'polling came back' }]]);

    expect(suppress(items, origins({ t1: OWN, t2: OWN }), claims)).toEqual(['t2']);
  });
});

/**
 * The one shape all three exemptions take. A time-traveled read, a disabled knob and a failed
 * origin lookup each arrive with nothing resolved, so none of them can subtract anything.
 */
describe('a recall with no origins resolved', () => {
  it('withholds nothing', () => {
    expect(suppress([item('c1'), item('c2')], new Map())).toEqual([]);
  });
});

import type { RelatedClaim } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { suppressedNearDuplicates } from './pack-duplicates.js';
import { assemble, item } from './test-support/pack.fixture.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ClaimSimilarity } from '../../infrastructure/graph/near-duplicate-queries.js';

/**
 * The readings the cases are built on are the ones committed against the shipped embedding
 * model on claim text: one assertion written twice runs to 0.981, and claims about one subject
 * that are not one assertion run to 0.932. The floor sits between them, so a pair standing at
 * the top of the second band is served at the worst reading that measurement recorded rather
 * than at a number chosen to make a test pass.
 */
const FLOOR = 0.965;

/** The strongest reading measured for two claims about one subject that state different things. */
const DISTINCT = 0.932;

/** Inside the top of the band where two claims are one assertion written twice. */
const RESTATED = 0.978;

const NO_PROVENANCE: ReadonlyMap<string, ItemProvenance> = new Map();
const NO_CLAIMS: ReadonlyMap<string, RelatedClaim> = new Map();

function pair(left: string, right: string, similarity: number): ClaimSimilarity {
  return { left, right, similarity };
}

function suppress(
  items: readonly FusedItem[],
  similarities: readonly ClaimSimilarity[],
  overrides: {
    provenance?: ReadonlyMap<string, ItemProvenance>;
    relatedClaims?: ReadonlyMap<string, RelatedClaim>;
  } = {},
): ReadonlySet<string> {
  return suppressedNearDuplicates({
    items,
    similarities,
    floor: FLOOR,
    provenance: overrides.provenance ?? NO_PROVENANCE,
    relatedClaims: overrides.relatedClaims ?? NO_CLAIMS,
  });
}

const LOGIN = ['Event', 'Memory', 'AionNode'];

describe('near-duplicate suppression', () => {
  it('prints one assertion once when the substrate holds two wordings of it', () => {
    const items = [
      item('login-a', { labels: LOGIN, content: 'the login flow moved to the edge worker' }),
      item('login-b', { labels: LOGIN, content: 'login now runs on the edge worker' }),
    ];

    expect([...suppress(items, [pair('login-a', 'login-b', RESTATED)])]).toEqual(['login-b']);
  });

  it('serves two occurrences of one kind of event, which state different things', () => {
    const items = [
      item('login-mon', { labels: LOGIN, content: 'Ana signed in from the Berlin office' }),
      item('login-fri', { labels: LOGIN, content: 'Ana signed in from the Tokyo office' }),
    ];

    expect(suppress(items, [pair('login-mon', 'login-fri', DISTINCT)]).size).toBe(0);
  });

  it('serves a claim and its negation, which is the pair a reader most needs both of', () => {
    const items = [
      item('flag-on', { labels: LOGIN, content: 'passkey login is enabled for staff' }),
      item('flag-off', { labels: LOGIN, content: 'passkey login is disabled for staff' }),
    ];

    expect(suppress(items, [pair('flag-on', 'flag-off', DISTINCT)]).size).toBe(0);
  });

  it('serves a claim somebody stated is wrong, however closely it is worded', () => {
    const items = [
      item('claim', { labels: LOGIN, content: 'the seed limit is ten' }),
      item('correction', { labels: LOGIN, content: 'the seed limit is now twelve' }),
    ];
    const provenance = new Map<string, ItemProvenance>([
      [
        'claim',
        {
          roots: [],
          complete: true,
          claimedCorrection: { by: 'episode-9', at: new Date('2026-09-01T00:00:00.000Z') },
        },
      ],
    ]);

    expect(suppress(items, [pair('claim', 'correction', RESTATED)], { provenance }).size).toBe(0);
  });

  it('serves a claim with a successor, since the lineage is what the reader is missing', () => {
    const items = [
      item('old', { labels: LOGIN, content: 'the seed limit is ten', superseded: true }),
      item('new', { labels: LOGIN, content: 'the seed limit is ten now' }),
    ];

    expect(suppress(items, [pair('old', 'new', RESTATED)]).size).toBe(0);
  });

  it('serves a claim the substrate has since answered differently', () => {
    const items = [
      item('turn', { labels: LOGIN, content: 'we run Postgres for the queue' }),
      item('claim', { labels: LOGIN, content: 'the queue runs on Postgres' }),
    ];
    const relatedClaims = new Map<string, RelatedClaim>([
      ['turn', { id: 'claim-current', text: 'the queue runs on Valkey' }],
    ]);

    expect(suppress(items, [pair('turn', 'claim', RESTATED)], { relatedClaims }).size).toBe(0);
  });

  it('never folds a quotation into an inference, whatever the two measure', () => {
    const items = [
      item('said', {
        labels: ['Turn', 'Memory', 'AionNode'],
        content: 'we decided to keep Neo4j',
      }),
      item('read', { labels: LOGIN, content: 'the team decided to keep Neo4j' }),
    ];

    expect(suppress(items, [pair('said', 'read', RESTATED)]).size).toBe(0);
  });

  it('leaves a pair under the floor alone, which is the whole not-one-assertion band', () => {
    const items = [
      item('one', { labels: LOGIN, content: 'the worker retries on SQLITE_BUSY' }),
      item('two', { labels: LOGIN, content: 'the worker gives up on SQLITE_BUSY' }),
    ];

    expect(suppress(items, [pair('one', 'two', FLOOR - 0.001)]).size).toBe(0);
    expect(suppress(items, [pair('one', 'two', FLOOR)]).size).toBe(1);
  });

  it('holds nothing back on the strength of an item it already held back', () => {
    const items = [
      item('first', { labels: LOGIN, content: 'the queue drains newest first' }),
      item('second', { labels: LOGIN, content: 'the queue drains newest first, always' }),
      item('third', { labels: LOGIN, content: 'draining is newest first' }),
    ];
    // The middle item is a restatement of the first and the third is a restatement only of the
    // middle one, so the third is a memory the reader has not been shown.
    const suppressed = suppress(items, [
      pair('first', 'second', RESTATED),
      pair('second', 'third', RESTATED),
    ]);

    expect([...suppressed]).toEqual(['second']);
  });
});

describe('a pack that suppressed a near-duplicate', () => {
  const items = [
    item('login-a', { labels: LOGIN, content: 'the login flow moved to the edge worker' }),
    item('login-b', { labels: LOGIN, content: 'login now runs on the edge worker' }),
  ];

  it('spends its budget once and says in the rendered text that it did', () => {
    const pack = assemble(items, { suppressedDuplicates: new Set(['login-b']) });

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['login-a']);
    expect(pack.rendered_text).toContain('1 item restating one already served here');
    expect(pack.metadata.suppressed_duplicates).toBe(1);
  });

  it('prints both and says nothing when the subtraction found no pair', () => {
    const pack = assemble(items);

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['login-a', 'login-b']);
    expect(pack.rendered_text).not.toContain('restating');
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });
});

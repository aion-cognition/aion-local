import type { RelatedClaim } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import type { FusedItem } from './fusion.js';
import { foldableClaims } from './pack-duplicates.js';
import { assemble, item } from './test-support/pack.fixture.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { RestatedClaimPair } from '../../infrastructure/graph/near-duplicate-queries.js';

/**
 * What a pack does with two records of one claim. Which pairs reach here at all is the
 * nomination query's, and `near-duplicate.int.test.ts` holds the counterexamples that decide
 * it against a real graph.
 */

const LABELS = ['Insight', 'Memory', 'AionNode'];

const NO_CLAIMS: ReadonlyMap<string, RelatedClaim> = new Map();

/** A successful provenance read answers for every candidate, with or without anything to say. */
function read(...ids: readonly string[]): ReadonlyMap<string, ItemProvenance> {
  return new Map(ids.map((id) => [id, { roots: [id], complete: true }]));
}

function pairOf(items: readonly FusedItem[]): readonly RestatedClaimPair[] {
  return [{ left: items[0]?.id ?? '', right: items[1]?.id ?? '' }];
}

function foldable(
  items: readonly FusedItem[],
  overrides: {
    provenance?: ReadonlyMap<string, ItemProvenance>;
    relatedClaims?: ReadonlyMap<string, RelatedClaim>;
    pairs?: readonly RestatedClaimPair[];
  } = {},
): ReadonlyMap<string, ReadonlySet<string>> {
  return foldableClaims({
    items,
    pairs: overrides.pairs ?? pairOf(items),
    provenance: overrides.provenance ?? read(...items.map((entry) => entry.id)),
    relatedClaims: overrides.relatedClaims ?? NO_CLAIMS,
  });
}

function twins(): FusedItem[] {
  return [
    item('first', { labels: LABELS, content: 'The queue runs on Valkey.' }),
    item('second', { labels: LABELS, content: 'the queue runs on Valkey' }),
  ];
}

describe('which records of one claim may stand in for each other', () => {
  it('lets either of a nominated pair stand in for the other', () => {
    const map = foldable(twins());

    expect([...(map.get('first') ?? [])]).toEqual(['second']);
    expect([...(map.get('second') ?? [])]).toEqual(['first']);
  });

  it('folds nothing the nomination query did not pair', () => {
    expect(foldable(twins(), { pairs: [] }).size).toBe(0);
  });

  it('keeps a claim somebody stated is wrong, however it is worded', () => {
    const provenance = new Map<string, ItemProvenance>([
      ['first', { roots: ['a'], complete: true }],
      [
        'second',
        {
          roots: ['b'],
          complete: true,
          claimedCorrection: { by: 'episode-9', at: new Date('2026-09-01T00:00:00.000Z') },
        },
      ],
    ]);

    expect(foldable(twins(), { provenance }).size).toBe(0);
  });

  it('keeps a claim with a successor, since the lineage is what the reader is missing', () => {
    const items = [
      item('first', { labels: LABELS, content: 'The queue runs on Valkey.', superseded: true }),
      item('second', { labels: LABELS, content: 'the queue runs on Valkey' }),
    ];

    expect(foldable(items).size).toBe(0);
  });

  it('keeps a claim the substrate has since answered differently', () => {
    const relatedClaims = new Map<string, RelatedClaim>([
      ['first', { id: 'claim-current', text: 'the queue runs on Postgres' }],
    ]);

    expect(foldable(twins(), { relatedClaims }).size).toBe(0);
  });

  it('never folds a quotation into an inference', () => {
    const items = [
      item('first', {
        labels: ['Turn', 'Memory', 'AionNode'],
        content: 'the queue runs on Valkey',
      }),
      item('second', { labels: LABELS, content: 'The queue runs on Valkey.' }),
    ];

    expect(foldable(items).size).toBe(0);
  });

  it('withholds nothing when provenance could not answer for both sides', () => {
    // The read fails soft to an empty map while the pairing read can still succeed, so an
    // absent record is an unknown standing and an unknown correction, never a licence.
    expect(foldable(twins(), { provenance: new Map() }).size).toBe(0);
    expect(foldable(twins(), { provenance: read('first') }).size).toBe(0);
    expect(foldable(twins(), { provenance: read('second') }).size).toBe(0);
  });

  it('ignores a pair naming a candidate this pack never held', () => {
    expect(foldable(twins(), { pairs: [{ left: 'first', right: 'absent' }] }).size).toBe(0);
  });
});

describe('a pack that holds one claim twice', () => {
  const eligible = new Map<string, ReadonlySet<string>>([
    ['first', new Set(['second'])],
    ['second', new Set(['first'])],
  ]);

  it('prints the better-ranked record and says in the rendered text that it did', () => {
    const pack = assemble(twins(), { foldable: eligible });

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['first']);
    expect(pack.rendered_text).toContain('1 item restating one already served here');
    expect(pack.metadata.suppressed_duplicates).toBe(1);
  });

  it('prints both and says nothing when nothing was eligible', () => {
    const pack = assemble(twins());

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['first', 'second']);
    expect(pack.rendered_text).not.toContain('restating');
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });

  it('serves the fitting record when the better-ranked one exceeds the token budget', () => {
    const items = [
      item('first', {
        labels: LABELS,
        content: 'The queue retries five times.',
        why: 'The archived operational rationale explains the retry policy. '.repeat(120),
      }),
      item('second', { labels: LABELS, content: 'The queue retries at most five times.' }),
    ];

    expect(assemble(items, { tokenBudget: 110 }).facts?.map((fact) => fact.id)).toEqual(['second']);
    const pack = assemble(items, { tokenBudget: 110, foldable: eligible });
    expect(pack.facts?.map((fact) => fact.id)).toEqual(['second']);
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });

  it('serves the second record when the first is cut as a cue restatement', () => {
    const items = [
      item('first', { labels: ['Goal', 'Memory', 'AionNode'], content: 'The queue retries.' }),
      item('second', { labels: ['Goal', 'Memory', 'AionNode'], content: 'the queue retries' }),
    ];
    const pack = assemble(items, { restating: new Set(['first']), foldable: eligible });

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['second']);
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });

  it('serves the second record when a bucket cap turned the first away', () => {
    const items = [
      item('first', { labels: ['Episode', 'Memory', 'AionNode'], content: 'The queue retries.' }),
      item('second', { labels: LABELS, content: 'the queue retries' }),
    ];
    const caps = {
      facts: 15,
      episodes: 0,
      narratives: 5,
      intentions: 3,
      preferences: 3,
      resonant: 5,
    };
    const pack = assemble(items, { caps, foldable: eligible });

    expect(pack.episodes).toBeUndefined();
    expect(pack.facts?.map((fact) => fact.id)).toEqual(['second']);
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });

  it('counts nothing when a cap, and not the fold, is what turned a record away', () => {
    const items = [
      item('other', { labels: LABELS, content: 'Something else entirely.' }),
      item('first', { labels: LABELS, content: 'The queue retries.' }),
      item('second', { labels: LABELS, content: 'the queue retries' }),
    ];
    const caps = {
      facts: 2,
      episodes: 5,
      narratives: 5,
      intentions: 3,
      preferences: 3,
      resonant: 5,
    };
    const pack = assemble(items, { caps, foldable: eligible });

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['other', 'first']);
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });

  it('folds a resonant discovery into the fused record the query already answered with', () => {
    const [first, second] = twins();
    const pack = assemble(first === undefined ? [] : [first], {
      resonant: second === undefined ? [] : [second],
      foldable: eligible,
    });

    expect(pack.facts?.map((fact) => fact.id)).toEqual(['first']);
    expect(pack.resonant).toBeUndefined();
    expect(pack.metadata.suppressed_duplicates).toBe(1);
  });
});

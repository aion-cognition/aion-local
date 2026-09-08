import type { RelatedClaim } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import { foldableClaims } from './pack-duplicates.js';
import { emittedPackIds } from './session-dedup.js';
import { candidate, ids, items, list } from './test-support/fusion.fixture.js';
import { assemble, CAPS, item } from './test-support/pack.fixture.js';
import { viewOf } from './test-support/resolved-view.fixture.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';

/**
 * What the pack says about where its items came from, and about two of them saying one thing.
 * Assembly order decides which item claims a root first, so every case here fixes an order and
 * asserts the pack reads the same either way.
 */

const CLAIM_LABELS = ['Insight', 'Memory', 'AionNode'];

/** A capture and the claim pulled out of it: one witness, whichever of the two is packed first. */
function oneSource(): ReadonlyMap<string, ItemProvenance> {
  return new Map([
    ['claim', { roots: ['root'], lineage: ['root'], complete: true }],
    ['root', { roots: ['root'], lineage: ['root'], complete: true }],
  ]);
}

describe('a source and its own extracted claim in one pack', () => {
  it('says they are one witness when the source is packed first', () => {
    const pack = assemble([item('root'), item('claim', { labels: CLAIM_LABELS })], {
      provenance: oneSource(),
    });

    expect(pack.rendered_text).toContain('not independent corroboration');
    expect(pack.facts?.[0]?.derivation?.shared_with).toEqual(['root']);
  });

  it('says they are one witness when the claim is packed first', () => {
    const pack = assemble([item('claim', { labels: CLAIM_LABELS }), item('root')], {
      provenance: oneSource(),
    });

    expect(pack.rendered_text).toContain('not independent corroboration');
    expect(pack.episodes?.[0]?.derivation?.shared_with).toEqual(['claim']);
  });

  it('marks the source that arrives through the second pass behind its own claim', () => {
    const pack = assemble([item('claim', { labels: CLAIM_LABELS })], {
      resonant: [item('root')],
      provenance: oneSource(),
    });

    expect(pack.resonant?.[0]?.derivation?.shared_with).toEqual(['claim']);
    expect(pack.rendered_text).toContain('not independent corroboration');
  });

  /**
   * The overlap is the whole of the news here: a capture derives from itself, so printing the
   * root would tell the reader nothing, and the chain ended where it was supposed to.
   */
  it('prints the overlap without a derivation line for a capture that is its own root', () => {
    const pack = assemble([item('claim', { labels: CLAIM_LABELS }), item('root')], {
      provenance: oneSource(),
    });

    expect(pack.episodes?.[0]?.derivation).toEqual({
      roots: [],
      complete: true,
      shared_with: ['claim'],
    });
    expect(pack.rendered_text).not.toContain('derives from');
  });

  it('leaves a lone capture with no derivation at all', () => {
    const pack = assemble([item('root')], {
      provenance: new Map([['root', { roots: ['root'], lineage: ['root'], complete: true }]]),
    });

    expect(pack.episodes?.[0]?.derivation).toBeUndefined();
    expect(pack.rendered_text).not.toContain('not independent corroboration');
  });

  it('leaves the claim alone when the budget turns the source away', () => {
    const provenance = oneSource();
    const claimOnly = assemble([item('claim', { labels: CLAIM_LABELS })], { provenance });
    const pack = assemble([item('claim', { labels: CLAIM_LABELS }), item('root')], {
      provenance,
      tokenBudget: claimOnly.metadata.token_estimate,
    });

    expect(pack.episodes).toBeUndefined();
    expect(pack.facts?.map((entry) => entry.id)).toEqual(['claim']);
    expect(pack.rendered_text).not.toContain('not independent corroboration');
  });

  it('leaves the claim alone when a cap turns the source away', () => {
    const pack = assemble([item('claim', { labels: CLAIM_LABELS }), item('root')], {
      provenance: oneSource(),
      caps: { ...CAPS, episodes: 0 },
    });

    expect(pack.episodes).toBeUndefined();
    expect(pack.facts?.[0]?.derivation?.shared_with).toBeUndefined();
    expect(pack.rendered_text).not.toContain('not independent corroboration');
  });
});

/**
 * Two node ids carrying one sentence are not one memory. A quotation and a model's reading of it
 * say the same words with different authority behind them, and a record somebody corrected or
 * confirmed says the same words and means something else. Only a decision that can see standing,
 * subject identity and the graph's own key can tell a repeat from a second record, so text alone
 * decides nothing before that decision runs.
 */
describe('two ids that carry one sentence', () => {
  const TEXT = 'The queue runs on Valkey.';
  const CLAIM_LABELS_FULL = ['Insight', 'Memory', 'AionNode'];
  const NO_CLAIMS: ReadonlyMap<string, RelatedClaim> = new Map();

  const CORRECTION = { by: 'correction-episode', at: new Date('2026-09-01T08:00:00.000Z') };
  const CONFIRMATION = {
    by: 'Ryan Huber',
    at: new Date('2026-09-01T10:00:00.000Z'),
    evidence: 'design review 42',
  };

  it('keeps a recorded utterance and an extracted reading of it apart through fusion', () => {
    const fused = items([
      list('vector', [
        candidate('utterance', { labels: ['Turn'], content: TEXT }),
        candidate('interpretation', { labels: ['Insight'], content: TEXT }),
      ]),
    ]);

    expect(ids(fused)).toEqual(['utterance', 'interpretation']);
  });

  it('still merges one id two retrieval legs found into a single candidate', () => {
    const fused = items([
      list('vector', [candidate('one', { content: TEXT })]),
      list('bm25', [candidate('one', { method: 'bm25', relevance: 0.5, content: TEXT })]),
    ]);

    expect(ids(fused)).toEqual(['one']);
    expect(fused[0]?.evidence).toHaveLength(2);
  });

  it('keeps a corrected record whose text equals one the query already answered with', () => {
    const first = item('first', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const corrected = item('corrected', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const provenance = new Map<string, ItemProvenance>([
      ['first', { roots: ['root-a'], complete: true }],
      ['corrected', { roots: ['root-b'], complete: true, claimedCorrection: CORRECTION }],
    ]);
    const foldable = foldableClaims({
      items: [first, corrected],
      pairs: [{ left: first.id, right: corrected.id }],
      view: viewOf({ provenance, relatedClaims: NO_CLAIMS }),
    });

    // The eligibility policy already refuses this pair, which is what makes an earlier text-only
    // subtraction of the same two records a decision nothing checked.
    expect(foldable.size).toBe(0);
    const ranked = assemble([first, corrected], { provenance, foldable });
    expect([...emittedPackIds(ranked)]).toEqual(['first', 'corrected']);
    const beside = assemble([first], { resonant: [corrected], provenance, foldable });
    expect([...emittedPackIds(beside)]).toContain('corrected');
    const volunteered = assemble([first], { intentions: [corrected], provenance, foldable });
    expect([...emittedPackIds(volunteered)]).toContain('corrected');
  });

  it('keeps a confirmed interpretation beside the identical recorded utterance', () => {
    const utterance = item('utterance', { labels: ['Turn', 'Memory', 'AionNode'], content: TEXT });
    const confirmed = item('interpretation', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const provenance = new Map<string, ItemProvenance>([
      [utterance.id, { roots: ['root-a'], complete: true, recordedRole: 'assistant' }],
      [confirmed.id, { roots: ['root-b'], complete: true, confirmation: CONFIRMATION }],
    ]);

    const pack = assemble([utterance], { resonant: [confirmed], provenance });

    expect(pack.rendered_text).toContain('design review 42');
  });

  it('still folds a pair the substrate keys and reads as one claim', () => {
    const first = item('first', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const second = item('second', {
      labels: CLAIM_LABELS_FULL,
      content: 'the queue runs on valkey',
    });
    const provenance = new Map<string, ItemProvenance>([
      ['first', { roots: ['first'], complete: true }],
      ['second', { roots: ['second'], complete: true }],
    ]);
    const foldable = foldableClaims({
      items: [first, second],
      pairs: [{ left: first.id, right: second.id }],
      view: viewOf({ provenance, relatedClaims: NO_CLAIMS }),
    });

    const pack = assemble([first, second], { provenance, foldable });

    expect(pack.facts?.map((entry) => entry.id)).toEqual(['first']);
    expect(pack.metadata.suppressed_duplicates).toBe(1);
  });

  it('folds nothing when the provenance read answered for only one of the two', () => {
    const first = item('first', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const second = item('second', { labels: CLAIM_LABELS_FULL, content: TEXT });
    const provenance = new Map<string, ItemProvenance>([
      ['first', { roots: ['first'], complete: true }],
    ]);
    const foldable = foldableClaims({
      items: [first, second],
      pairs: [{ left: first.id, right: second.id }],
      view: viewOf({ provenance, relatedClaims: NO_CLAIMS }),
    });

    expect(foldable.size).toBe(0);
    expect(assemble([first, second], { provenance, foldable }).facts?.map((e) => e.id)).toEqual([
      'first',
      'second',
    ]);
  });

  /** The knob turns the fold off; it never licenses printing one node twice. */
  it('prints one node once when duplicate suppression is off', () => {
    const pack = assemble([item('one', { content: TEXT })], {
      resonant: [item('one', { content: TEXT })],
    });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['one']);
    expect(pack.resonant).toBeUndefined();
    expect(pack.metadata.suppressed_duplicates).toBeUndefined();
  });
});

describe('two memories from one source', () => {
  const ROOT = new Map([
    ['c1', { roots: ['ep-root'], complete: true }],
    ['c2', { roots: ['ep-root'], complete: true }],
  ]);

  it('exposes the shared origin rather than letting one source read as two witnesses', () => {
    const pack = assemble([item('c1'), item('c2')], { provenance: ROOT });

    expect(pack.episodes?.[0]?.derivation?.shared_with).toBeUndefined();
    expect(pack.episodes?.[1]?.derivation?.shared_with).toEqual(['c1']);
    expect(pack.rendered_text).toContain(
      'shares this origin with c1: not independent corroboration',
    );
  });

  it('claims a root only for an item the pack actually served', () => {
    // c1 is cut by the cap, so c2 is the first item in the pack to descend from the root and
    // has nobody to share it with.
    const pack = assemble([item('c1'), item('c2')], {
      provenance: ROOT,
      caps: { ...CAPS, episodes: 1 },
    });

    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['c1']);
    expect(pack.episodes?.[0]?.derivation?.shared_with).toBeUndefined();
  });

  it('leaves two memories from different roots alone', () => {
    const pack = assemble([item('c1'), item('c2')], {
      provenance: new Map([
        ['c1', { roots: ['ep-a'], complete: true }],
        ['c2', { roots: ['ep-b'], complete: true }],
      ]),
    });

    expect(pack.episodes?.[1]?.derivation?.shared_with).toBeUndefined();
  });
});

describe('one source reaching the pack twice', () => {
  it('marks the root and its own extracted claim as one source', () => {
    const pack = assemble(
      [item('root'), item('claim', { labels: ['Insight', 'Memory', 'AionNode'] })],
      {
        provenance: new Map([
          ['root', { roots: ['root'], complete: true }],
          ['claim', { roots: ['root'], complete: true }],
        ]),
      },
    );
    expect(pack.episodes?.map((entry) => entry.id)).toContain('root');
    expect(pack.facts?.map((entry) => entry.id)).toContain('claim');
    expect(pack.rendered_text).toContain('not independent corroboration');
  });
  it('prefers a known successor arriving through resonance', () => {
    const stale = item('stale', { superseded: true, content: 'old account' });
    const fresh = item('stale-successor', { content: 'new account' });
    const alone = assemble([stale]);
    const freshAlone = assemble([], {
      resonant: [fresh],
      tokenBudget: alone.metadata.token_estimate,
    });
    expect(freshAlone.resonant?.map((entry) => entry.id) ?? []).toContain('stale-successor');
    const pack = assemble([stale], {
      resonant: [fresh],
      tokenBudget: alone.metadata.token_estimate,
    });
    expect(pack.resonant?.map((entry) => entry.id) ?? []).toContain('stale-successor');
  });
});

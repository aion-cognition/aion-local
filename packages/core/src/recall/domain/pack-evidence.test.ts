import { describe, expect, it } from 'vitest';

import { assemble, CAPS, item } from './test-support/pack.fixture.js';
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

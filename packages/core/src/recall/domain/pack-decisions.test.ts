import { describe, expect, it } from 'vitest';

import type { PackDecision } from './pack-decisions.js';
import { assemble, CAPS, item } from './test-support/pack.fixture.js';

/**
 * What assembly reports about each candidate it looked at. The reasons have to stay apart:
 * a fold, a bucket cap and the token budget turn an item away for different reasons, and a
 * report that cannot tell them apart cannot say what a change to the pack cost.
 */

function decisionsFrom(
  items: Parameters<typeof assemble>[0],
  overrides: Parameters<typeof assemble>[1] = {},
): readonly PackDecision[] {
  const seen: PackDecision[] = [];
  assemble(items, {
    ...overrides,
    onDecision: (decision) => {
      seen.push(decision);
    },
  });
  return seen;
}

describe('the decisions assembly reports', () => {
  it('says nothing at all when nobody is watching', () => {
    const pack = assemble([item('e1'), item('e2')]);
    expect(pack.episodes?.map((entry) => entry.id)).toEqual(['e1', 'e2']);
  });

  it('names the accepted item with the rank it took', () => {
    const decisions = decisionsFrom([item('e1'), item('e2')]);
    expect(decisions).toEqual([
      { id: 'e1', bucket: 'episodes', reason: 'accepted', rank: 1 },
      { id: 'e2', bucket: 'episodes', reason: 'accepted', rank: 2 },
    ]);
  });

  it('names the folded candidate and the twin it stands behind', () => {
    const foldable = new Map([
      ['e1', new Set(['e2'])],
      ['e2', new Set(['e1'])],
    ]);
    const decisions = decisionsFrom([item('e1'), item('e2')], { foldable });

    expect(decisions).toEqual([
      { id: 'e1', bucket: 'episodes', reason: 'accepted', rank: 1 },
      { id: 'e2', bucket: 'episodes', reason: 'folded', standsInFor: 'e1' },
    ]);
  });

  it('reports a bucket cap apart from a fold', () => {
    const items = ['e1', 'e2', 'e3'].map((id) => item(id));
    const decisions = decisionsFrom(items, { caps: { ...CAPS, episodes: 2 } });

    expect(decisions.map((decision) => decision.reason)).toEqual([
      'accepted',
      'accepted',
      'bucket_cap',
    ]);
    expect(decisions[2]?.id).toBe('e3');
  });

  it('reports the token budget apart from both', () => {
    const items = ['e1', 'e2', 'e3'].map((id) => item(id, { content: 'x'.repeat(2000) }));
    const decisions = decisionsFrom(items, { tokenBudget: 700 });

    expect(decisions.map((decision) => decision.reason)).toEqual([
      'accepted',
      'token_budget',
      'token_budget',
    ]);
  });

  it('calls a second sighting of one id identity rather than a fold', () => {
    const decisions = decisionsFrom([item('e1'), item('e1')]);
    expect(decisions).toEqual([
      { id: 'e1', bucket: 'episodes', reason: 'accepted', rank: 1 },
      { id: 'e1', bucket: 'episodes', reason: 'already_packed' },
    ]);
  });

  it('agrees with the count the pack prints', () => {
    const foldable = new Map([
      ['e1', new Set(['e2'])],
      ['e2', new Set(['e1'])],
    ]);
    const seen: PackDecision[] = [];
    const pack = assemble([item('e1'), item('e2')], {
      foldable,
      onDecision: (decision) => {
        seen.push(decision);
      },
    });

    expect(pack.metadata.suppressed_duplicates).toBe(1);
    expect(seen.filter((decision) => decision.reason === 'folded')).toHaveLength(1);
  });
});

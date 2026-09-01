import { describe, expect, it } from 'vitest';

import { describeUnmergedDecision, parseUnmergeFlags } from './unmerge.js';

describe('parseUnmergeFlags', () => {
  it('lists what one canonical entity absorbed', () => {
    expect(parseUnmergeFlags(['ls', 'entity-1'])).toEqual({ subcommand: 'ls', id: 'entity-1' });
  });

  it('applies against the absorbed id, which is what the merge record names', () => {
    expect(parseUnmergeFlags(['apply', 'entity-2'])).toEqual({
      subcommand: 'apply',
      id: 'entity-2',
    });
  });

  it('refuses either subcommand with no id', () => {
    expect(() => parseUnmergeFlags(['ls'])).toThrow('unmerge ls needs a canonical entity id');
    expect(() => parseUnmergeFlags(['apply'])).toThrow(
      'unmerge apply needs the absorbed entity id',
    );
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => parseUnmergeFlags(['split', 'entity-1'])).toThrow(
      "unknown unmerge subcommand 'split' (supported: ls, apply)",
    );
  });
});

describe('describeUnmergedDecision', () => {
  it('names the tier that merged and every reason it recorded', () => {
    expect(
      describeUnmergedDecision({
        id: 'decision-1',
        tier: 'tier0',
        reasons: ['both names squash to aionlocal'],
      }),
    ).toBe('merged by tier0: both names squash to aionlocal');
  });

  it('says a record with no reasons has none rather than printing an empty tail', () => {
    expect(describeUnmergedDecision({ id: 'decision-2', tier: 'tier3', reasons: [] })).toBe(
      'merged by tier3: no reason recorded',
    );
  });
});

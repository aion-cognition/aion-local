import { describe, expect, it } from 'vitest';

import {
  MissingUnmergeIdError,
  parseUnmergeFlags,
  UnknownUnmergeSubcommandError,
} from './unmerge.js';

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
    expect(() => parseUnmergeFlags(['ls'])).toThrow(MissingUnmergeIdError);
    expect(() => parseUnmergeFlags(['apply'])).toThrow(MissingUnmergeIdError);
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => parseUnmergeFlags(['split', 'entity-1'])).toThrow(UnknownUnmergeSubcommandError);
  });
});

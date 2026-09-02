import { describe, expect, it } from 'vitest';

import { wouldAutoApply } from './merge-shadow.js';

describe('wouldAutoApply', () => {
  it('is true for names that fold to the same string', () => {
    expect(wouldAutoApply('Postgres', 'postgres')).toBe(true);
    expect(wouldAutoApply('Alice Chen', 'alice chen')).toBe(true);
  });

  it('collapses inner whitespace and trims before comparing', () => {
    expect(wouldAutoApply('  Alice   Chen ', 'Alice Chen')).toBe(true);
  });

  it('is true for the separator variants the sweep exists to catch', () => {
    // The shape exact-fold equality could never see, and the whole reason the sweep still has
    // work to do on a graph whose uniqueness key already folds names.
    expect(wouldAutoApply('aion-local', 'aion_local')).toBe(true);
    expect(wouldAutoApply('name norm', 'name-norm')).toBe(true);
  });

  it('is false for a name that only contains the other as a substring', () => {
    // The character-overlap rule entity-identity.ts uses for merge *candidates* would score
    // this pair above its own threshold; it lands as `bigram`, which decides nothing.
    expect(wouldAutoApply('UserPromptSubmit', 'UserPromptSubmit hook')).toBe(false);
  });

  it('is false for two spellings whose digits disagree', () => {
    expect(wouldAutoApply('beta-episode-1', 'beta_episode_2')).toBe(false);
  });

  it('is false for names that differ only in a diacritic', () => {
    expect(wouldAutoApply('resume', 'résumé')).toBe(false);
  });

  it('is false for two different names entirely', () => {
    expect(wouldAutoApply('Zephyr Ingest', 'Downstream Consumer')).toBe(false);
  });
});

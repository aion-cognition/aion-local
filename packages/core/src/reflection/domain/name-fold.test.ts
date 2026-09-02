import { describe, expect, it } from 'vitest';

import { foldForIdentity, foldName } from './name-fold.js';

describe('foldForIdentity', () => {
  it('folds case the way the ASCII lowercase it replaced did', () => {
    expect(foldForIdentity('Redis')).toBe('redis');
    expect(foldForIdentity('Thandiwe Baptiste')).toBe('thandiwe baptiste');
  });

  it('reduces compatibility forms to their canonical spelling', () => {
    // Fullwidth latin, the ﬁ ligature, and a squared unit: three spellings of text a
    // lowercase mapping alone leaves as separate keys.
    expect(foldForIdentity('ＰＯＳＴＧＲＥＳ')).toBe('postgres');
    expect(foldForIdentity('ﬁle')).toBe('file');
    expect(foldForIdentity('㎏')).toBe('kg');
  });

  it('applies the full case folds a lowercase mapping stops short of', () => {
    expect(foldForIdentity('STRASSE')).toBe(foldForIdentity('Straße'));
    expect(foldForIdentity('ΟΔΟΣ')).toBe(foldForIdentity('οδος'));
  });

  it('keeps distinct non-ASCII names apart after folding', () => {
    // The embedding model returned one constant vector for both. The fold must not be what
    // makes them equal on top of that.
    expect(foldForIdentity('Zoë Müller')).toBe('zoë müller');
    expect(foldForIdentity('José Álvarez')).toBe('josé álvarez');
    expect(foldForIdentity('Zoë Müller')).not.toBe(foldForIdentity('José Álvarez'));
    expect(foldForIdentity('naïve')).not.toBe(foldForIdentity('café'));
  });

  it('is idempotent and unifies the two spellings of a decomposed accent', () => {
    const composed = 'Zo\u00eb';
    const decomposed = 'Zoe\u0308';
    expect(foldForIdentity(composed)).toBe(foldForIdentity(decomposed));
    expect(foldForIdentity(foldForIdentity(composed))).toBe(foldForIdentity(composed));
  });

  it('leaves text that carries no case alone', () => {
    expect(foldForIdentity('🌊')).toBe('🌊');
    expect(foldForIdentity('東京')).toBe('東京');
  });
});

describe('foldName', () => {
  it('trims and collapses inner whitespace on top of the fold', () => {
    expect(foldName('  Ryan   Huber ')).toBe('ryan huber');
  });

  it('collapses the compatibility spaces NFKC turns into ordinary ones', () => {
    expect(foldName('Ryan 　Huber')).toBe('ryan huber');
  });
});

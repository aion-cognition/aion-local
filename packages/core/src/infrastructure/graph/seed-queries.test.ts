import { describe, expect, it } from 'vitest';
import { escapeLuceneQuery, normalizeSeedName } from './seed-queries.js';

describe('normalizeSeedName', () => {
  it('folds case and collapses whitespace, matching what the backbone writes into name_norm', () => {
    expect(normalizeSeedName('  Ryan   Huber ')).toBe('ryan huber');
    expect(normalizeSeedName('GLOBAL')).toBe('global');
  });

  it('keeps every character of the name, since this is key folding and not term extraction', () => {
    expect(normalizeSeedName('solace-health-server')).toBe('solace-health-server');
    expect(normalizeSeedName('the and of')).toBe('the and of');
  });

  it('reports an empty name as empty rather than inventing one', () => {
    expect(normalizeSeedName('   ')).toBe('');
  });
});

describe('escapeLuceneQuery', () => {
  it('escapes every query-parser metacharacter', () => {
    expect(escapeLuceneQuery('useEffect()')).toBe('useEffect\\(\\)');
    expect(escapeLuceneQuery('--max-old-space-size')).toBe('\\-\\-max\\-old\\-space\\-size');
    expect(escapeLuceneQuery('a && b || c')).toBe('a \\&\\& b \\|\\| c');
    expect(escapeLuceneQuery('field:value^2 ~fuzzy* ?wild')).toBe(
      'field\\:value\\^2 \\~fuzzy\\* \\?wild',
    );
    expect(escapeLuceneQuery('C:\\Users\\path')).toBe('C\\:\\\\Users\\\\path');
    expect(escapeLuceneQuery('[range] {curly} "quoted" !bang +plus')).toBe(
      '\\[range\\] \\{curly\\} \\"quoted\\" \\!bang \\+plus',
    );
  });

  it('leaves the cue text otherwise verbatim: no splitting, no dropping, no reordering', () => {
    expect(escapeLuceneQuery('the reflection queue claim path')).toBe(
      'the reflection queue claim path',
    );
    expect(escapeLuceneQuery('SQLITE_BUSY')).toBe('SQLITE_BUSY');
  });

  it('trims so a whitespace-only cue is detectable as empty', () => {
    expect(escapeLuceneQuery('  spaced  ')).toBe('spaced');
    expect(escapeLuceneQuery('   ')).toBe('');
  });
});

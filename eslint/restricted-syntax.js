/**
 * Shared restricted syntax rules used by multiple config layers. These are
 * extracted to prevent duplication when flat-config merges the no-restricted-syntax
 * rule value by full replacement rather than concatenation.
 */

export const SHARED_RESTRICTED_SYNTAX = [
  {
    selector: 'ForInStatement',
    message: 'Iterate Object.keys/values/entries instead of for-in.',
  },
  {
    selector: 'LabeledStatement',
    message: 'Restructure instead of labeling loops.',
  },
  {
    selector: 'WithStatement',
    message: 'with is banned.',
  },
];

/**
 * The JavaScript core: the Airbnb style guide's semantic rules, updated for
 * current ECMAScript. Formatting is Prettier's job, so no layout rules appear
 * here, and the Airbnb rules that aged out are documented in the README rather
 * than silently dropped.
 */

import { SHARED_RESTRICTED_SYNTAX } from './restricted-syntax.js';

export default {
  name: 'aion/base',
  rules: {
    // Correctness and intent
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    curly: ['error', 'all'],
    'default-case-last': 'error',
    'grouped-accessor-pairs': ['error', 'getBeforeSet'],
    'no-caller': 'error',
    'no-constructor-return': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-extend-native': 'error',
    'no-iterator': 'error',
    'no-proto': 'error',
    'no-new-wrappers': 'error',
    'no-object-constructor': 'error',
    'no-return-assign': ['error', 'always'],
    'no-self-compare': 'error',
    'no-sequences': 'error',
    'no-template-curly-in-string': 'error',
    'no-unmodified-loop-condition': 'error',
    'no-unreachable-loop': 'error',
    'no-promise-executor-return': 'error',
    'no-async-promise-executor': 'error',
    'require-atomic-updates': 'error',
    'symbol-description': 'error',
    radix: ['error', 'as-needed'],
    yoda: 'error',

    // State discipline
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-param-reassign': [
      'error',
      { props: true, ignorePropertyModificationsFor: ['acc', 'out', 'draft'] },
    ],
    'no-multi-assign': 'error',
    'one-var': ['error', 'never'],
    'operator-assignment': ['error', 'always'],

    // Modern syntax over legacy forms
    'object-shorthand': ['error', 'always'],
    'prefer-template': 'error',
    'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
    'prefer-destructuring': [
      'error',
      { object: true, array: false },
      { enforceForRenamedProperties: false },
    ],
    'prefer-spread': 'error',
    'prefer-rest-params': 'error',
    'prefer-object-spread': 'error',
    'prefer-object-has-own': 'error',
    'prefer-numeric-literals': 'error',
    'prefer-exponentiation-operator': 'error',
    'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
    'no-useless-call': 'error',
    'no-useless-computed-key': 'error',
    'no-useless-concat': 'error',
    'no-useless-rename': 'error',
    'no-useless-return': 'error',

    // Readability
    'no-else-return': ['error', { allowElseIf: false }],
    'no-lonely-if': 'error',
    'no-nested-ternary': 'error',
    'no-unneeded-ternary': ['error', { defaultAssignment: false }],
    'no-negated-condition': 'error',
    'no-bitwise': 'error',
    'no-console': 'warn',
    'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],

    // Restricted constructs. for-in invites prototype surprises; labels and
    // with are complexity escape hatches nothing here needs. The Airbnb for-of
    // ban is deliberately absent: iterators are the modern default.
    'no-restricted-syntax': ['error', ...SHARED_RESTRICTED_SYNTAX],
  },
};

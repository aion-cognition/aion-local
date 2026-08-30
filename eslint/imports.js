import importX from 'eslint-plugin-import-x';

/**
 * Import discipline via eslint-plugin-import-x. Named exports are the default
 * (the Airbnb prefer-default-export is inverted on purpose: named exports
 * survive renames, greps, and re-exports better). Relative imports carry the
 * .js extension because NodeNext resolution requires it at runtime.
 */
export default {
  name: 'aion/imports',
  plugins: { 'import-x': importX },
  rules: {
    'import-x/first': 'error',
    'import-x/newline-after-import': 'error',
    'import-x/no-duplicates': 'error',
    'import-x/no-self-import': 'error',
    'import-x/no-useless-path-segments': ['error', { noUselessIndex: false }],
    'import-x/no-cycle': ['error', { maxDepth: 8 }],
    'import-x/no-default-export': 'warn',
    'import-x/extensions': ['error', 'ignorePackages', { js: 'always', ts: 'never' }],
    'import-x/order': [
      'error',
      {
        groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
  },
};

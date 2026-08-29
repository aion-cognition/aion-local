/**
 * The TypeScript layer, applied on top of typescript-eslint's own
 * strict-type-checked and stylistic-type-checked presets (extended in
 * index.js; first-party baselines are used, not duplicated). This file holds
 * only what is ours: tunings that override preset defaults, and house
 * additions the presets do not activate.
 */
export default {
  name: 'aion/typescript',
  rules: {
    // Preset overrides
    '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/restrict-template-expressions': [
      'error',
      { allowNumber: true, allowBoolean: true },
    ],

    // House additions past the presets
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-import-type-side-effects': 'error',
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': 'error',
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': [
      'error',
      { functions: false, classes: true, variables: true },
    ],
    'default-param-last': 'off',
    '@typescript-eslint/default-param-last': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': [
      'error',
      { considerDefaultExhaustiveForUnions: true },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/member-ordering': 'off',

    // Names: types are PascalCase, values are camelCase, module constants may
    // shout. Object properties are exempt because wire formats are snake_case.
    '@typescript-eslint/naming-convention': [
      'error',
      { selector: 'typeLike', format: ['PascalCase'] },
      {
        selector: 'variable',
        modifiers: ['const', 'global'],
        format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
      },
      { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
      { selector: 'function', format: ['camelCase'] },
      { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
      { selector: 'import', format: null },
    ],

    // Inline import() type expressions hide dependencies from the import
    // block; a type used in a signature earns a top-level import.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'TSImportType',
        message: 'Use a top-level import for types, never inline import() expressions.',
      },
      {
        selector: 'ForInStatement',
        message: 'Iterate Object.keys/values/entries instead of for-in.',
      },
      { selector: 'LabeledStatement', message: 'Restructure instead of labeling loops.' },
      { selector: 'WithStatement', message: 'with is banned.' },
    ],
  },
};

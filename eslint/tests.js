/**
 * Relaxations for test files, fixtures, and test support. Tests mock, stub,
 * and build awkward shapes on purpose; holding them to production strictness
 * produces suppression comments, not safety.
 */
export default {
  name: 'aion/tests',
  files: [
    '**/*.test.ts',
    '**/*.int.test.ts',
    '**/*.fixture.ts',
    '**/*.fixtures.ts',
    '**/test-support/**',
  ],
  rules: {
    'max-lines': 'off',
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/unbound-method': 'off',
    '@typescript-eslint/require-await': 'off',
  },
};

import { defineConfig } from 'eslint/config';

import aion from './eslint/index.js';

/**
 * Repo wiring for the portable ruleset in eslint/. Scoping, ignores, the
 * type-aware parser hookup, and path-specific overrides live here; the rules
 * themselves live in eslint/ so they can extract into a library untouched.
 */
export default defineConfig([
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'eslint/**', '*.config.js'],
  },
  {
    files: ['packages/**/*.ts'],
    extends: aion,
    languageOptions: {
      parserOptions: {
        // The build tsconfigs exclude tests and fixtures, so typed linting
        // runs against a lint-only project that includes every source file.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The CLI and the quality harness print to a human on purpose.
    files: ['packages/cli/**/*.ts', '**/test-support/quality-harness/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Gate fixtures seed substrates at whatever size the scenario needs.
    files: ['packages/mcp/src/gate/**/*.ts'],
    rules: { 'max-lines': 'off' },
  },
]);

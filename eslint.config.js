import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

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
        project: './tsconfig.tests.json',
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
  {
    // Standalone scripts that child_process spawns directly. They sit outside
    // tsconfig.tests.json on purpose, so type-aware linting cannot see them.
    files: [
      'packages/core/src/infrastructure/sqlite/claim-worker.fixture.ts',
      'packages/core/src/infrastructure/sqlite/concurrent-writer.fixture.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);

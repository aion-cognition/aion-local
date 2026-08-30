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
  {
    // TEMPORARY: these files consume service and driver responses untyped, so the
    // unsafe-* family fires on every downstream access. The fix is typing each
    // boundary once, not annotating hundreds of sites; that lands with the
    // boundary-typing sweep. Remove this block when it does.
    files: [
      'packages/mcp/src/bootstrap.ts',
      'packages/cli/src/doctor.ts',
      'packages/cli/src/proposals.ts',
      'packages/cli/src/stats.ts',
      'packages/cli/src/why.ts',
      'packages/cli/src/status.ts',
      'packages/cli/src/maintain.ts',
      'packages/cli/src/queue.ts',
      'packages/cli/src/unmerge.ts',
      'packages/cli/src/search.ts',
      'packages/cli/src/forget.ts',
      'packages/cli/src/last.ts',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
]);

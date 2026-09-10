import { defineConfig } from 'vitest/config';

/**
 * The ruled cold-barrel CLI unit qualification: the reviewer's guard as a setup file, so an
 * actual backend construction or HTTP call is caught and still fails the run.
 */
export default defineConfig({
  test: {
    include: [
      'packages/cli/src/t10bf1-lifecycle-composition-review.test.ts',
      'packages/cli/src/maintain.test.ts',
    ],
    setupFiles: ['packages/core/src/infrastructure/providers/review-only-guard/t10bf1-no-model.fixture.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});

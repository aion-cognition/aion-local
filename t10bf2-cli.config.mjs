import original from './vitest.config.ts';

/**
 * The ruled cold-barrel CLI unit qualification: the reviewer's guard as a setup file, so an
 * actual backend construction or HTTP call is caught and still fails the run.
 *
 * `original.resolve` is not decoration. The repository resolves `@aion/*` to TypeScript source, and
 * a config that drops it lets the workspace barrel resolve to compiled output while the guard mocks
 * the source module: two different constructors, and a guard watching the one the code under test
 * never calls. The qualification is only evidence if both are the same function.
 */
export default {
  resolve: original.resolve,
  test: {
    include: [
      'packages/cli/src/t10bf1-lifecycle-composition-review.test.ts',
      'packages/cli/src/maintain.test.ts',
      'packages/core/src/infrastructure/providers/review-only-guard/t10bf2-barrel-binding-review.test.ts',
    ],
    setupFiles: [
      'packages/core/src/infrastructure/providers/review-only-guard/t10bf1-no-model.fixture.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
};

import { defineConfig } from 'vitest/config';

/** The negative control: a deliberate backend construction, which the guard must catch. */
export default defineConfig({
  test: {
    include: ['packages/core/src/infrastructure/providers/review-only-guard/t10bf1-no-model-control.test.ts'],
    setupFiles: ['packages/core/src/infrastructure/providers/review-only-guard/t10bf1-no-model.fixture.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});

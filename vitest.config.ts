import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests import workspace packages by their published specifier but must run against
// TypeScript source, not dist, so `npm test` never depends on a prior `npm run build`.
const alias = [
  { find: /^@aion\/([a-z-]+)\/(.+)$/, replacement: `${root}packages/$1/src/$2` },
  { find: /^@aion\/([a-z-]+)$/, replacement: `${root}packages/$1/src` },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['packages/*/src/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 300_000,
          // Starts the one throwaway Neo4j the whole run shares and publishes its address to
          // every file. A file run outside this project finds no address and starts a
          // container of its own instead.
          globalSetup: [`${root}packages/core/src/infrastructure/graph/test-support/neo4j-global-setup.fixture.ts`],
          // Files lease that one container one at a time, and each clears the database on the
          // way in. Two files at once would wipe each other's graph mid-test, so serial
          // execution is what makes sharing safe rather than a resource-contention workaround.
          fileParallelism: false,
          // Removing the container is the last thing the run does, and the ten-second default
          // is the only thing between a slow `docker rm` and a container left behind.
          teardownTimeout: 60_000,
        },
      },
    ],
  },
});

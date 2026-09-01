import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { integrationPoolSize } from './packages/core/src/infrastructure/graph/test-support/neo4j-lease.fixture.js';

const root = fileURLToPath(new URL('.', import.meta.url));

// A developer-kept warm container (scripts/test-neo4j.mjs) serves every file itself, so the
// run must stay serial: two files at once would wipe the one database out from under each
// other. Without it, global setup boots a container pool and files can run abreast, each
// holding an exclusive lease on a database of its own.
const warmNeo4j = process.env.TEST_SHARED_NEO4J_URI !== undefined;

// These two assert on the Ollama daemon's resident-model list, which the whole machine
// shares: they force a model in, trigger an eviction, and poll until it is gone. Any file
// generating against the same model mid-eviction reloads it and fails the poll, so they run
// in their own project, serially, after everything else has stopped talking to Ollama.
const ollamaStateTests = [
  'packages/core/src/infrastructure/providers/model-reconciliation.int.test.ts',
  'packages/mcp/src/routing-key-flip.int.test.ts',
];

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
          exclude: ['**/node_modules/**', '**/dist/**', ...ollamaStateTests],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 300_000,
          // Unit first, then this project, then the Ollama-state tail: groups with a lower
          // order finish before the next one starts.
          sequence: { groupOrder: 1 },
          // Starts the run's pool of throwaway Neo4j containers and publishes it to every
          // file; each file claims a free container, clears it, and releases it when done. A
          // file run outside this project finds no pool and starts a container of its own
          // instead.
          globalSetup: [
            `${root}packages/core/src/infrastructure/graph/test-support/neo4j-global-setup.fixture.ts`,
          ],
          fileParallelism: !warmNeo4j,
          // Workers beyond the pool size only queue on the lease, so the two numbers match.
          // Forks, not threads: files mutate process.env and must not see each other do it.
          pool: 'forks',
          maxWorkers: warmNeo4j ? 1 : integrationPoolSize(),
          // Removing the containers is the last thing the run does, and the ten-second default
          // is the only thing between a slow `docker rm` and a container left behind.
          teardownTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration-ollama',
          include: ollamaStateTests,
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 300_000,
          sequence: { groupOrder: 2 },
          // No pool: only routing-key-flip touches Neo4j, and it boots a dedicated container
          // through the harness fallback. Serial, so the two files cannot fight over the
          // daemon either.
          fileParallelism: false,
          pool: 'forks',
          teardownTimeout: 60_000,
        },
      },
    ],
  },
});

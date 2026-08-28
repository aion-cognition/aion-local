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
        },
      },
    ],
  },
});

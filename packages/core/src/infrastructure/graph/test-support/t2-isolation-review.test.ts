import type * as Neo4jDriverModule from 'neo4j-driver';
import { afterEach, expect, it, vi } from 'vitest';

import { startRehearsalSubstrate } from './consolidation-rehearsal.fixture.js';
import { checkRehearsalTarget } from '../../../introspection/domain/campaign-isolation.js';

const calls = vi.hoisted(() => ({
  statements: [] as string[],
  driver: {
    verifyConnectivity: vi.fn(async () => undefined),
    executeQuery: vi.fn(async (statement: string) => {
      calls.statements.push(statement);
      return {
        records: [],
        summary: { counters: { updates: () => ({ nodesDeleted: 0 }) } },
      };
    }),
    close: vi.fn(async () => undefined),
  },
}));

vi.mock('neo4j-driver', async (original) => {
  const module = await original<typeof Neo4jDriverModule>();
  return { ...module, default: { ...module.default, driver: () => calls.driver } };
});

afterEach(() => {
  vi.unstubAllEnvs();
  calls.statements.length = 0;
});

it('refuses a production-matching shared target before any statement executes', async () => {
  vi.stubEnv('TEST_NEO4J_POOL', undefined);
  vi.stubEnv('TEST_NEO4J_LEASE_DIR', undefined);
  vi.stubEnv('TEST_SHARED_NEO4J_URI', 'bolt://production.invalid:9999');
  vi.stubEnv('TEST_SHARED_NEO4J_PASSWORD', 'fake-only');
  vi.stubEnv('TEST_SHARED_NEO4J_CONTAINER', 'arbitrary-env-name');
  await expect(
    startRehearsalSubstrate({
      production: {
        graphUri: 'bolt://production.invalid:9999',
        sqlitePath: '/production/aion.sqlite',
      },
    }),
  ).rejects.toMatchObject({ name: 'RehearsalTargetRefused' });
  expect(calls.statements).toEqual([]);
});

it('treats direct and routing schemes naming the same host and port as overlapping', () => {
  const target = { graphUri: 'neo4j://localhost:7687', sqlitePath: '/clone/aion.sqlite' };
  const verdict = checkRehearsalTarget({
    target,
    production: { graphUri: 'bolt://127.0.0.1:7687', sqlitePath: '/production/aion.sqlite' },
    declaration: {
      kind: 'declared_clone',
      verifiedGraphUri: target.graphUri,
      verifiedSqlitePath: target.sqlitePath,
    },
  });
  expect(verdict).toMatchObject({ status: 'rejected', reason: 'production_graph_endpoint' });
});

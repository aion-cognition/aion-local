import type * as Neo4jDriverModule from 'neo4j-driver';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../../infrastructure/sqlite/experience-archive.js';

const fake = vi.hoisted(() => ({
  verifyConnectivity: vi.fn(async () => {
    throw new Error('review graph unavailable');
  }),
  executeQuery: vi.fn(async () => {
    throw new Error('review graph unavailable');
  }),
  close: vi.fn(async () => undefined),
}));
vi.mock('neo4j-driver', async (original) => {
  const module = await original<typeof Neo4jDriverModule>();
  return { ...module, default: { ...module.default, driver: () => fake } };
});
vi.mock('../../../infrastructure/config/load-config.js', async () => {
  const { DEFAULTS } = await import('../../../infrastructure/config/defaults.js');
  return { loadConfig: () => DEFAULTS };
});

it('writes healthy SQLite readings before refusing a manifest during a graph outage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-cli-baseline-review-'));
  const filePath = join(dir, 'store.sqlite');
  const store = new SqliteStore({ filePath });
  insertExperience(store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'v1',
    identity: 'reader-fixture',
    sessionId: 'session-fixture',
    episodeId: 'episode-fixture',
    contentHash: 'fixture-hash',
    occurredAt: '2026-09-08T00:00:00Z',
    archivedAt: '2026-09-08T00:00:00Z',
    payload: { observations: ['a fixture observation'] },
  });
  store.close();
  const previousArgv = process.argv;
  process.argv = ['node', 'campaign-baseline', dir, '--sqlite', filePath];
  try {
    await expect(import('./run.js')).rejects.toThrow('cohort walk incomplete');
    const files = readdirSync(dir);
    const baselineFile = files.find((name) => name.startsWith('campaign-baseline-'));
    expect(baselineFile).toBeDefined();
    const baseline = JSON.parse(readFileSync(join(dir, baselineFile ?? ''), 'utf8')) as {
      archive: { rows: number };
      graphNote: string;
      failures: Record<string, string>;
    };
    expect(baseline.archive.rows).toBe(1);
    expect(baseline.graphNote).toContain('review graph unavailable');
    expect(baseline.failures.graph_sources).toContain('review graph unavailable');
    expect(files.some((name) => name.startsWith('campaign-manifest-'))).toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
  } finally {
    process.argv = previousArgv;
    rmSync(dir, { recursive: true, force: true });
  }
});

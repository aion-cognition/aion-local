import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectBaseline, type CampaignBaseline } from './baseline.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import {
  SqliteStore,
  openReadOnlySqliteHandle,
  type SqliteHandle,
} from '../../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../../infrastructure/sqlite/experience-archive.js';

/**
 * What the collector persists and what it refuses to claim, against real stores. Its subject is
 * the pages on disk and the membership read back off them, neither of which an in-memory double
 * can produce honestly.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const SAMPLED_AT = '2026-09-01T10:00:00.000Z';

let harness: Neo4jHarness;
let dataDir: string;
let exportDir: string;
let store: SqliteStore;
let reader: SqliteHandle;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-campaign-baseline-int-'));
  exportDir = join(dataDir, 'export');
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, store.db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: 'baseline-episode-1',
    now: NOW,
    properties: { text: 'a stored episode', session_id: 'baseline-session' },
  });
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id: 'baseline-narrative-1',
    now: NOW,
    properties: { text: 'a narrative nothing points at' },
  });
  insertExperience(store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'v1',
    identity: 'baseline-identity',
    sessionId: 'baseline-session',
    episodeId: 'baseline-episode-1',
    contentHash: 'baseline-hash',
    occurredAt: '2026-09-01T08:00:00.000Z',
    archivedAt: '2026-09-01T08:00:00.000Z',
    payload: { observations: ['a stored episode'] },
  });
  reader = openReadOnlySqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
}, 300_000);

afterAll(async () => {
  reader.close();
  await stopNeo4jHarness(harness);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function collect(dir: string): Promise<CampaignBaseline> {
  return collectBaseline({
    driver: harness.driver,
    db: reader,
    sampledAt: SAMPLED_AT,
    exportDir: dir,
  });
}

describe('what the collector persists', () => {
  it('writes a page and a progress record for every cohort it walks', async () => {
    const dir = join(exportDir, 'first');
    const baseline = await collect(dir);
    expect(baseline.exportComplete).toBe(true);

    for (const cohort of ['narrative-edges', 'graph-sources', 'narratives']) {
      const files = readdirSync(join(dir, cohort));
      expect(files).toContain('progress.json');
    }
    const progress = JSON.parse(readFileSync(join(dir, 'narratives', 'progress.json'), 'utf8')) as {
      accounted: string[];
    };
    expect(progress.accounted).toEqual(['baseline-narrative-1']);
  }, 120_000);

  it('reports the membership it read back off the persisted pages', async () => {
    const baseline = await collect(join(exportDir, 'second'));
    expect(baseline.graphSourceIds).toEqual(['baseline-episode-1']);
    expect(baseline.narrativeIds).toEqual(['baseline-narrative-1']);
    expect(baseline.failures).toEqual({});
  }, 120_000);

  it('counts calls under their own name and leaves cost uncollected', async () => {
    const baseline = await collect(join(exportDir, 'third'));
    expect(baseline.gauges.independent_outcomes.api_call_census).toMatchObject({
      status: 'measured',
      value: 0,
      unit: 'api calls',
    });
    expect(baseline.gauges.independent_outcomes.cost_by_surface).toMatchObject({
      status: 'unavailable',
      reason: 'not_collected',
    });
  }, 120_000);
});

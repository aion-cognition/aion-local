import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collectBaseline, type CampaignBaseline } from './baseline.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { readRelationshipTypeCounts } from '../../../infrastructure/graph/campaign-cohort-queries.js';
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
import { GAUGE_OBSERVATIONS, GAUGE_GROUPS } from '../../domain/campaign-gauge-groups.js';

/**
 * The baseline against real stores. Its subject is the difference between a store that holds
 * nothing and a store that is not there, which no in-memory double can produce honestly.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-01T09:00:00.000Z');
const SAMPLED_AT = '2026-09-01T10:00:00.000Z';

let harness: Neo4jHarness;
let dataDir: string;
let store: SqliteStore;
let reader: SqliteHandle;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-campaign-baseline-int-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, store.db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: 'baseline-episode-1',
    now: NOW,
    properties: { text: 'a stored episode', session_id: 'baseline-session' },
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
  await writeStampedNode(harness.driver, {
    label: 'Narrative',
    id: 'unlinked-narrative-review',
    now: NOW,
    properties: { text: 'A retained narrative with no remaining source edges' },
  });
  reader = openReadOnlySqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
}, 300_000);

afterAll(async () => {
  reader.close();
  await stopNeo4jHarness(harness);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function collect(withDb: boolean): Promise<CampaignBaseline> {
  return collectBaseline({
    driver: harness.driver,
    ...(withDb ? { db: reader } : {}),
    sampledAt: SAMPLED_AT,
  });
}

it('includes an unlinked narrative in the retained narrative membership', async () => {
  const baseline = await collect(true);
  expect(baseline.labelPopulations?.Narrative).toBe(1);
  expect(baseline.narrativeIds).toContain('unlinked-narrative-review');
});

describe('what the baseline reports', () => {
  it('reports a real zero for a population that is genuinely empty', async () => {
    const baseline = await collect(true);
    expect(baseline.gauges.independent_outcomes.stale_edge_partition).toMatchObject({
      status: 'measured',
      value: 0,
      unit: 'edges',
    });
    expect(baseline.gauges.independent_outcomes.stale_edge_partition).toHaveProperty('basis');
  });

  it('names the scan ceiling on a reading a ceiling bounds', async () => {
    const baseline = await collect(true);
    const orphans = baseline.gauges.independent_outcomes.orphan_count;
    expect(orphans).toMatchObject({ status: 'measured' });
    expect(orphans?.basis.denominator).toContain('scanned');
  });

  it('reports the schema that does not exist as unavailable in every one of its groups', async () => {
    const baseline = await collect(true);
    for (const group of GAUGE_GROUPS) {
      if (group === 'independent_outcomes') {
        continue;
      }
      const gauges = Object.values(baseline.gauges[group]);
      expect(gauges).toHaveLength(GAUGE_OBSERVATIONS[group].length);
      for (const gauge of gauges) {
        expect(gauge).toMatchObject({ status: 'unavailable', reason: 'not_installed' });
      }
    }
  });

  it('reports the cost meter as unavailable when no substrate was reachable', async () => {
    const baseline = await collect(false);
    expect(baseline.gauges.independent_outcomes.cost_by_surface).toMatchObject({
      status: 'unavailable',
      reason: 'store_unavailable',
    });
    expect(baseline.archive).toBe(undefined);
  });

  it('measures the stored corpus against the proposed request bounds', async () => {
    const baseline = await collect(true);
    expect(baseline.limitReports.request_turns).toMatchObject({ limit: 200, exceedingCount: 0 });
    expect(baseline.limitReports.raw_source_bytes?.distribution?.count).toBe(1);
  });

  it('carries the frozen membership itself rather than only its size', async () => {
    const baseline = await collect(true);
    expect(baseline.graphSourceIds).toEqual(['baseline-episode-1']);
  });

  it('leaves the graph exactly as it found it', async () => {
    const before = await readRelationshipTypeCounts(harness.driver);
    await collect(true);
    expect(await readRelationshipTypeCounts(harness.driver)).toEqual(before);
  });
});

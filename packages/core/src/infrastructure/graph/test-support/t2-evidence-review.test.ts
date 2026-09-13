import Database from 'better-sqlite3';
import type { Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { loadIncidentCapture, packageIncidentFixture } from './consolidation-incident.fixture.js';
import {
  advanceProgress,
  boundPage,
  exportIsComplete,
} from '../../../introspection/domain/campaign-paging.js';
import { collectBaseline } from '../../../introspection/test-support/campaign/baseline.js';
import { appendApiCall } from '../../sqlite/api-usage.js';
import { SqliteStore } from '../../sqlite/database.js';

const dirs: string[] = [];
const emptyDriver = {
  executeQuery: async () => ({ records: [] }),
} as unknown as Driver;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses a required decoded artifact omitted from the manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aion-review-artifact-'));
  dirs.push(dir);
  const targets = JSON.stringify({ targets: [], sources: [], lineage: [], archive: [] });
  writeFileSync(join(dir, 'targets.json'), targets);
  writeFileSync(
    join(dir, 'provenance.json'),
    JSON.stringify({ proposals: [{ id: 'unverified-proposal' }] }),
  );
  writeFileSync(
    join(dir, 'SHA256SUMS'),
    `${createHash('sha256').update(targets).digest('hex')}  targets.json\n`,
  );
  expect(loadIncidentCapture(dir)).toMatchObject({ status: 'failed' });
});

// The capture lives outside the repository, so this case runs where a run names it.
it.runIf(process.env.AION_CAMPAIGN_INCIDENT_DIR !== undefined)(
  'preserves a verified redacted raw source for statement-scope fixtures',
  () => {
    const result = loadIncidentCapture(process.env.AION_CAMPAIGN_INCIDENT_DIR);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      throw new Error('The durable capture is required for this probe');
    }
    const fixture = packageIncidentFixture(result.capture, 'incident-snapshot');
    // The source's three roles and occurrence clocks are in its stored archive payload.
    // Inspect keys only, without printing that payload into the test log.
    expect(Object.keys(fixture.archive[1] ?? {})).toContain('payload');
  },
);

it('does not certify an oversized export before its bytes are saved', () => {
  const shape = {
    key: (row: { id: string; bytes: number }) => row.id,
    bytes: (row: { id: string; bytes: number }) => row.bytes,
  };
  const page = boundPage([{ id: 'huge-source', bytes: 3000000 }], shape);
  expect(page.rows).toEqual([]);
  const progress = advanceProgress({ accounted: [] }, page, shape);
  expect(exportIsComplete(progress, ['huge-source']).complete).toBe(false);
});

it('reports absent installed tables as unavailable instead of throwing', async () => {
  const db = new Database(':memory:');
  try {
    await expect(
      collectBaseline({
        driver: emptyDriver,
        db,
        sampledAt: '2026-09-08T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      gauges: {
        independent_outcomes: {
          cost_by_surface: { status: 'unavailable', reason: 'not_installed' },
        },
      },
    });
  } finally {
    db.close();
  }
});

it('reports graph unavailability through the gauge envelope', async () => {
  const unavailable = {
    executeQuery: async () => {
      throw new Error('simulated graph outage');
    },
  } as unknown as Driver;
  await expect(
    collectBaseline({
      driver: unavailable,
      sampledAt: '2026-09-08T00:00:00.000Z',
    }),
  ).resolves.toHaveProperty('gauges.independent_outcomes');
});

it('does not label an API row count as measured cost', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    appendApiCall(store.db, {
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
      model: 'test-model',
      surface: 'cues',
      inputTokens: 100,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      attempts: 1,
      durationMs: 1,
    });
    const baseline = await collectBaseline({
      driver: emptyDriver,
      db: store.db,
      sampledAt: '2026-09-08T00:00:00.000Z',
    });
    expect(baseline.gauges.independent_outcomes.cost_by_surface).toMatchObject({
      status: 'unavailable',
      reason: 'not_collected',
    });
  } finally {
    store.close();
  }
});

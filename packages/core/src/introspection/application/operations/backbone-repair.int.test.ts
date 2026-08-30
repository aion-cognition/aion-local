import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backboneRepairOperation, backboneRepairRelevance } from './backbone-repair.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { countEpisodesWithoutSession } from '../../../infrastructure/graph/introspection-health.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  sessionIdsOfEpisode,
  sessionLinkSignals,
} from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { NEUTRAL_GRAPH_HEALTH } from '../../domain/health.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Three episodes: one wired correctly, one whose session link is missing but whose session is
 * still there, and one naming a session the graph does not hold. Only the middle one is
 * repairable, and the third is what keeps the operation from inventing a container.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = DEFAULTS;

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedEpisode(id: string, sessionId: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `body of ${id}`, session_id: sessionId },
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-backbone-repair-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'session-live',
    now: NOW,
    properties: { started_at: NOW.toISOString() },
  });

  await seedEpisode('episode-wired', 'session-live');
  await upsertEdge(harness.driver, {
    type: 'PARTICIPATES_IN',
    sourceId: 'episode-wired',
    targetId: 'session-live',
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });

  await seedEpisode('episode-unlinked', 'session-live');
  await seedEpisode('episode-sessionless', 'session-that-never-landed');
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('emergency relationship repair', () => {
  it('stays at zero relevance until the snapshot reports a break', () => {
    expect(backboneRepairRelevance(healthFixture())).toBe(0);

    const broken = healthFixture({
      graph: { ...NEUTRAL_GRAPH_HEALTH, episodesWithoutSession: 20 },
    });
    expect(backboneRepairRelevance(broken)).toBeCloseTo(0.1, 6);
  });

  it('restores the link an episode already names and leaves the rest alone', async () => {
    expect(await countEpisodesWithoutSession(harness.driver)).toBe(2);
    expect(await sessionIdsOfEpisode(harness.driver, 'episode-unlinked')).toEqual([]);

    const outcome = await backboneRepairOperation().run(context());

    expect(outcome).toMatchObject({ status: 'applied', itemsProcessed: 1, itemsAffected: 1 });
    expect(await sessionIdsOfEpisode(harness.driver, 'episode-unlinked')).toEqual(['session-live']);
    expect(await sessionLinkSignals(harness.driver, 'episode-unlinked')).toContain(
      'backbone_repair',
    );
    // The one naming a session that is not there stays broken rather than being attached to
    // something invented for it.
    expect(await sessionIdsOfEpisode(harness.driver, 'episode-sessionless')).toEqual([]);
    expect(await countEpisodesWithoutSession(harness.driver)).toBe(1);
  });

  it('reports a no-op when nothing left in scope can be repaired', async () => {
    const outcome = await backboneRepairOperation().run(context());

    expect(outcome).toMatchObject({ status: 'noop', itemsAffected: 0 });
    expect(outcome.detail).toContain('no episode in scope');
  });
});

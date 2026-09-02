import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { identifierDecayOperation } from './identifier-decay.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { identifierEntityState } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The scan window has to move. Ineligible entities sitting at the head of the id order are the
 * ordinary case (most entities are plain words), so a sweep pinned to the lowest ids examines
 * the same page every run and never reaches the identifiers it exists to close.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-31T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - (DEFAULTS.maintenance.identifierHalfLifeDays + 13) * DAY_MS);

const SHA1 = '07e5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1';
/** Sorts ahead of the identifier, so a scan with no cursor never gets past it. */
const PLAIN_ID = 'aaa-decay-plain';
const IDENTIFIER_ID = 'zzz-decay-sha';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

/** One entity read per run, so two runs are needed to reach the second of the two entities. */
const config: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, identifierDecayBatch: 1 },
};

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

async function seedEntity(id: string, name: string): Promise<void> {
  const episodeId = `ep-${id}`;
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: episodeId,
    now: OLD,
    properties: { text: 'text', session_id: 'cursor-session' },
  });
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: OLD,
    properties: { name, name_norm: name.toLowerCase(), type: 'tool' },
  });
  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: episodeId,
    targetId: id,
    strength: 1,
    confidence: 0.8,
    signals: ['test'],
    provenance: ['test'],
    now: OLD,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-identifier-decay-cursor-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedEntity(PLAIN_ID, 'PostgreSQL');
  await seedEntity(IDENTIFIER_ID, SHA1);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('identifier_decay over a batch smaller than the substrate', () => {
  it('resumes past the ineligible head of the id order on the next run', async () => {
    const first = await identifierDecayOperation().run(context());
    expect(first.status).toBe('noop');
    expect(first.itemsProcessed).toBe(1);
    expect((await identifierEntityState(harness.driver, IDENTIFIER_ID)).validUntil).toBeUndefined();

    const second = await identifierDecayOperation().run(context());

    expect(second.status).toBe('applied');
    expect(second.itemsAffected).toBe(1);
    const closed = await identifierEntityState(harness.driver, IDENTIFIER_ID);
    expect(closed.validUntil).toBeInstanceOf(Date);
    expect(closed.closedBy).toBe('identifier_decay');
    // The plain word is never a subject, however many times the scan walks past it.
    expect((await identifierEntityState(harness.driver, PLAIN_ID)).validUntil).toBeUndefined();
  }, 120_000);
});

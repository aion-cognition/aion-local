import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findEpisodesMissingSessionLink } from './backbone-repair-queries.js';
import { writeStampedNode } from './bitemporal.js';
import { runWrite } from './connection.js';
import { runGraphMigrations } from './migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime } from './values.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Which broken episodes a bounded repair batch can actually see. The batch is oldest first, and
 * the oldest breaks are the ones most likely to name a session the graph no longer holds.
 */

const EMBED_DIMENSION = 4;

const OCCURRED_AT = new Date('2026-08-01T00:00:00.000Z');
const CLOSED_AT = new Date('2026-08-10T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, sessionId: string, txFrom: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: txFrom,
    occurredAt: OCCURRED_AT,
    properties: { text: id, session_id: sessionId },
  });
}

async function seedSession(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Session',
    id,
    now: OCCURRED_AT,
    properties: { name: id },
  });
}

async function closeSession(id: string): Promise<void> {
  await runWrite(
    harness.driver,
    'MATCH (s:Session { id: $id }) SET s.valid_until = $at RETURN s.id AS id',
    { id, at: toGraphDateTime(CLOSED_AT) },
    (row) => row.id as string,
  );
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-backbone-repair-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Oldest first: two unrepairable breaks ahead of the one break a repair can act on. No
  // episode here carries its session edge, which is what makes all three broken.
  await seedEpisode('ep-orphan', 'session-gone', new Date('2026-08-02T00:00:00.000Z'));
  await seedSession('session-closed');
  await closeSession('session-closed');
  await seedEpisode('ep-closed-session', 'session-closed', new Date('2026-08-03T00:00:00.000Z'));
  await seedSession('session-live');
  await seedEpisode('ep-repairable', 'session-live', new Date('2026-08-04T00:00:00.000Z'));
}, 300_000);

afterAll(async () => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  await stopNeo4jHarness(harness);
});

describe('the backbone repair scan', () => {
  it('spends a batch of one on the episode it can repair, not on the oldest break', async () => {
    const targets = await findEpisodesMissingSessionLink(harness.driver, 1);

    expect(targets).toEqual([{ episodeId: 'ep-repairable', sessionId: 'session-live' }]);
  });

  it('leaves an episode whose session is closed rather than forgotten', async () => {
    const targets = await findEpisodesMissingSessionLink(harness.driver, 10);

    expect(targets.map((target) => target.episodeId)).toEqual(['ep-repairable']);
  });
});

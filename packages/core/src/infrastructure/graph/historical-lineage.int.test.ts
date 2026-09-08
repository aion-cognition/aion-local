import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import { knewAt } from './read-modes.js';
import { findClaimSubjects } from './subject-family.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { SqliteStore } from '../sqlite/database.js';

/**
 * A question the present projection cannot answer: which entities a claim named at a moment
 * before the edge connecting them was written. All three nodes are older than the vantage and the
 * mention is not, so only the relationship's own clock separates the two answers.
 */

let dir: string;
let store: SqliteStore;
let substrate: RehearsalSubstrate;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-historical-lineage-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'db.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
}, 120000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('does not traverse a mention created after a historical subject-read vantage', async () => {
  await substrate.harness.driver.executeQuery(
    "CREATE (c:AionNode:Memory:Claim {id:'historical-claim',text_norm:'atlas result',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (s:AionNode:Memory:Episode {id:'historical-source',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (e:AionNode:Memory:Entity {id:'historical-entity',name:'Atlas',name_norm:'atlas',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (c)-[:EXTRACTED_FROM {created_at:datetime('2026-01-01T00:00:00Z')}]->(s) CREATE (s)-[:MENTIONS {created_at:datetime('2026-09-08T10:00:00Z')}]->(e)",
  );
  expect(await findClaimSubjects(substrate.harness.driver, 'historical-claim', {})).toHaveLength(1);
  expect(
    await findClaimSubjects(
      substrate.harness.driver,
      'historical-claim',
      knewAt(new Date('2026-09-08T09:00:00Z')),
    ),
  ).toEqual([]);
});

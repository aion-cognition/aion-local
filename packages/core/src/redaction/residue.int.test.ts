import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_ENTROPY_THRESHOLD } from './redact.js';
import { scanRedactionResidue } from './residue.js';
import { writeStampedNode } from '../infrastructure/graph/bitemporal.js';
import { readStoredText } from '../infrastructure/graph/introspection.js';
import { runGraphMigrations } from '../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../infrastructure/sqlite/database.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-residue-scan-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (let i = 0; i < 8; i += 1) {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: `residue-scan-${String(i).padStart(2, '0')}`,
      properties: { text: `node ${String(i)}` },
      now: NOW,
    });
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('scanRedactionResidue', () => {
  it('does not count a node as leaking on a match that only exists in the concatenated join', async () => {
    // Neither property leaks on its own: no value follows the key in the first, and the
    // second has no key context and reads as ordinary short text. Joined with a space, the
    // concatenated scan sees "the api_key: abcdefghij" and the generic-secret rule fires on
    // an artifact of the join, not on anything either property actually stores.
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'residue-cross-property',
      properties: { a: 'the api_key:', b: 'abcdefghij' },
      now: NOW,
    });

    const residue = await scanRedactionResidue(harness.driver, DEFAULT_ENTROPY_THRESHOLD, 100);

    expect(residue.leaking).toBe(0);
    expect(residue.sampleIds).not.toContain('residue-cross-property');
  }, 60_000);
});

describe('readStoredText scan ordering', () => {
  it('makes a smaller-limit scan a stable prefix of a larger-limit scan', async () => {
    const small = await readStoredText(harness.driver, 3);
    const large = await readStoredText(harness.driver, 8);

    // Without a deterministic order, a smaller scan and a larger scan are free to cover
    // disjoint nodes, which is what let the health check and the purge operation score and
    // rewrite different populations. Ordered, the small scan is exactly the large scan's head.
    expect(small.map((row) => row.id)).toEqual(large.slice(0, 3).map((row) => row.id));
  }, 60_000);
});

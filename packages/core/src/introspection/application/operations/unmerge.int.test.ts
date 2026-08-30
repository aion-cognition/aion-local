import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { entityUnmergeLedgerKey, listUnmergeableRecords, runEntityUnmerge } from './unmerge.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { redirectAndAbsorb } from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  mentionCounts,
  storedEntity,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';

/**
 * A merge and its reversal, end to end. Two spellings of one tool are merged, then split back
 * out, and both identities have to be whole afterwards: each answering to its own name, each
 * holding the edges it carried in, and the graph resolving the split name to the node that
 * now owns it rather than forward to the canonical.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const LATER = new Date('2026-08-29T15:00:00.000Z');

const CANONICAL_EPISODE = 'episode-canonical';
const DUPLICATE_EPISODE = 'episode-duplicate';
const NEIGHBOUR_CONCEPT = 'concept-storage';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let canonicalId: string;
let duplicateId: string;
let restoredId: string;

function entityInput(name: string, nameNorm: string, episodeId: string): EntityMergeInput {
  return {
    name,
    nameNorm,
    type: 'tool',
    text: `${name} is a database`,
    sourceEpisodeId: episodeId,
    extractionMethod: 'test',
    confidence: 0.9,
    occurredAt: NOW,
  };
}

async function seedEntity(input: EntityMergeInput): Promise<string> {
  const [merged] = await mergeEntities(harness.driver, [input], NOW);
  if (merged === undefined) {
    throw new Error(`failed to seed entity ${input.name}`);
  }
  return merged.id;
}

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `body of ${id}` },
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-unmerge-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedEpisode(CANONICAL_EPISODE);
  await seedEpisode(DUPLICATE_EPISODE);
  await writeStampedNode(harness.driver, {
    label: 'Concept',
    id: NEIGHBOUR_CONCEPT,
    now: NOW,
    properties: { text: 'relational storage' },
  });

  canonicalId = await seedEntity(entityInput('Postgres', 'postgres', CANONICAL_EPISODE));
  duplicateId = await seedEntity(entityInput('PostgreSQL', 'postgresql', DUPLICATE_EPISODE));

  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: CANONICAL_EPISODE,
    targetId: canonicalId,
    strength: 0.8,
    confidence: 0.8,
    signals: ['extraction'],
    provenance: ['test'],
    count: 2,
    now: NOW,
  });
  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: DUPLICATE_EPISODE,
    targetId: duplicateId,
    strength: 0.8,
    confidence: 0.8,
    signals: ['extraction'],
    provenance: ['test'],
    count: 3,
    now: NOW,
  });
  await upsertEdge(harness.driver, {
    type: 'RELATED_TO',
    sourceId: duplicateId,
    targetId: NEIGHBOUR_CONCEPT,
    strength: 0.7,
    confidence: 0.7,
    signals: ['association'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });

  await redirectAndAbsorb(harness.driver, {
    canonicalId,
    mergedIds: [duplicateId],
    aliases: ['PostgreSQL'],
    accessCount: 0,
    supersedeSignals: ['entity_merge'],
    supersedeProvenance: ['test'],
    mergedRecords: [
      {
        id: duplicateId,
        name: 'PostgreSQL',
        nameNorm: 'postgresql',
        type: 'tool',
        aliases: [],
      },
    ],
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('entity unmerge', () => {
  it('starts from a merge that absorbed the duplicate whole', async () => {
    const canonical = await storedEntity(harness.driver, canonicalId);
    const duplicate = await storedEntity(harness.driver, duplicateId);

    expect(canonical?.aliases).toEqual(['PostgreSQL']);
    expect(canonical?.validUntil).toBeNull();
    expect(duplicate?.validUntil).toBeInstanceOf(Date);
    // The merge redirects rather than removes: the episode's mention now reaches the canonical
    // as well, and the original edge to the closed node stays as the record that it did.
    expect(await mentionCounts(harness.driver, DUPLICATE_EPISODE)).toEqual(
      expect.arrayContaining([
        { id: duplicateId, count: 3 },
        { id: canonicalId, count: 3 },
      ]),
    );

    const records = await listUnmergeableRecords(harness.driver, canonicalId);
    expect(records.map((record) => record.mergedId)).toEqual([duplicateId]);
  });

  it('splits the absorbed identity back out with its own edges', async () => {
    const report = await runEntityUnmerge(
      { driver: harness.driver, db, logger },
      {
        mergedId: duplicateId,
        now: LATER,
      },
    );

    expect(report.status).toBe('applied');
    expect(report.canonicalId).toBe(canonicalId);
    expect(report.edgesRestored).toBe(2);
    expect(report.edgesSkipped).toBe(0);
    expect(report.aliasesReleased).toBe(1);
    restoredId = report.restoredId ?? '';
    expect(restoredId).not.toBe('');
    expect(restoredId).not.toBe(duplicateId);

    const restored = await storedEntity(harness.driver, restoredId);
    expect(restored?.name).toBe('PostgreSQL');
    expect(restored?.nameNorm).toBe('postgresql');
    expect(restored?.type).toBe('tool');
    expect(restored?.validUntil).toBeNull();

    const duplicateMentions = await mentionCounts(harness.driver, DUPLICATE_EPISODE);
    expect(duplicateMentions.find((row) => row.id === restoredId)?.count).toBe(3);
    expect(await supersedingNodeIds(harness.driver, duplicateId)).toContain(restoredId);
  });

  it('leaves the canonical current, and leaves what the merge folded into it alone', async () => {
    const canonical = await storedEntity(harness.driver, canonicalId);

    expect(canonical?.validUntil).toBeNull();
    expect(canonical?.aliases).toEqual([]);
    // The merge summed the redirected mention into the canonical's own and nothing records
    // what each side contributed, so the restore adds the split identity's edge back rather
    // than subtracting from an edge it can no longer take apart.
    expect(
      (await mentionCounts(harness.driver, DUPLICATE_EPISODE)).find((row) => row.id === canonicalId)
        ?.count,
    ).toBe(3);
  });

  it('hands the identity key to the restored node, so extraction stops resolving past it', async () => {
    const [resolved] = await mergeEntities(
      harness.driver,
      [entityInput('PostgreSQL', 'postgresql', DUPLICATE_EPISODE)],
      LATER,
    );

    expect(resolved?.id).toBe(restoredId);

    const closed = await storedEntity(harness.driver, duplicateId);
    expect(closed?.nameNorm).toBe(`postgresql#unmerged:${duplicateId}`);
    expect(closed?.name).toBe('PostgreSQL');
  });

  it('records the repair and refuses to run it twice', async () => {
    expect(isLedgerApplied(db, entityUnmergeLedgerKey(canonicalId, duplicateId))).toBe(true);
    expect(await listUnmergeableRecords(harness.driver, canonicalId)).toEqual([]);

    const second = await runEntityUnmerge(
      { driver: harness.driver, db, logger },
      {
        mergedId: duplicateId,
        now: LATER,
      },
    );

    expect(second.status).toBe('noop');
    expect(second.detail).toContain('already been split back out');
  });
});

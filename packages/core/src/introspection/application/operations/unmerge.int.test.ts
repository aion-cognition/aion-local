import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { entityUnmergeLedgerKey, listUnmergeableRecords, runEntityUnmerge } from './unmerge.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  loadEntityDedupDetails,
  redirectAndAbsorb,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
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
import {
  applyEntityMerge,
  collectMergeSignals,
} from '../../../reflection/application/entity-merge-writer.js';

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
    canonicalNameNorm: 'postgres',
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

describe('what a reversal can cite', () => {
  it('names the tier that merged and the reasons it recorded', async () => {
    const holderId = await seedEntity(entityInput('Valkey', 'valkey', CANONICAL_EPISODE));
    const absorbedId = await seedEntity(entityInput('val-key', 'val-key', CANONICAL_EPISODE));
    const [holder, absorbed] = await loadEntityDedupDetails(harness.driver, [holderId, absorbedId]);
    if (holder === undefined || absorbed === undefined) {
      throw new Error('failed to load the pair to merge');
    }

    const merge = await applyEntityMerge(
      { driver: harness.driver, db, logger },
      {
        canonical: holder,
        members: [holder, absorbed],
        tier: 'tier0',
        reasons: ['both names squash to valkey'],
        signals: await collectMergeSignals(harness.driver, holder, [holder, absorbed]),
        method: 'test_merge',
        now: NOW,
      },
    );
    expect(merge.status).toBe('merged');

    const report = await runEntityUnmerge(
      { driver: harness.driver, db, logger },
      { mergedId: absorbedId, now: LATER },
    );

    expect(report.status).toBe('applied');
    expect(report.decision).toEqual({
      id: merge.status === 'merged' ? merge.decisionId : '',
      tier: 'tier0',
      reasons: ['both names squash to valkey'],
    });
  }, 120_000);

  it('cites nothing on a merge written before the cascade recorded decisions', async () => {
    const keptId = await seedEntity(entityInput('Fenwick', 'fenwick', CANONICAL_EPISODE));
    const goneId = await seedEntity(entityInput('fen-wick', 'fen-wick', CANONICAL_EPISODE));
    await redirectAndAbsorb(harness.driver, {
      canonicalId: keptId,
      canonicalNameNorm: 'fenwick',
      mergedIds: [goneId],
      aliases: ['fen-wick'],
      accessCount: 0,
      mergedRecords: [
        { id: goneId, name: 'fen-wick', nameNorm: 'fen-wick', type: 'tool', aliases: [] },
      ],
      now: NOW,
    });

    const report = await runEntityUnmerge(
      { driver: harness.driver, db, logger },
      { mergedId: goneId, now: LATER },
    );

    expect(report.status).toBe('applied');
    expect(report.decision).toBeUndefined();
  }, 120_000);
});

const HOST_NAME_NORM = 'hydra';

async function absorbInto(
  hostId: string,
  mergedId: string,
  name: string,
  aliases: readonly string[],
): Promise<void> {
  await redirectAndAbsorb(harness.driver, {
    canonicalId: hostId,
    canonicalNameNorm: HOST_NAME_NORM,
    mergedIds: [mergedId],
    aliases,
    accessCount: 0,
    mergedRecords: [
      { id: mergedId, name, nameNorm: name.toLowerCase(), type: 'tool', aliases: [] },
    ],
    now: NOW,
  });
}

/**
 * A driver that lands one more merge on the canonical the moment the unmerge's first read
 * returns, which is the window the real system runs in: the reflection worker and the
 * introspector share one driver and merge into the same canonical while a person is deciding.
 */
function driverThatMergesAfterFirstRead(driver: Driver, land: () => Promise<void>): Driver {
  let pending: (() => Promise<void>) | undefined = land;
  return new Proxy(driver, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }
      const method = value.bind(target) as (...args: never[]) => Promise<unknown>;
      if (property !== 'executeQuery') {
        return method;
      }
      return async (...args: never[]): Promise<unknown> => {
        const result = await method(...args);
        const next = pending;
        pending = undefined;
        await next?.();
        return result;
      };
    },
  });
}

describe('a merge that lands while an unmerge is being decided', () => {
  it('keeps the record and the aliases that merge wrote', async () => {
    const hostId = await seedEntity(entityInput('Hydra', HOST_NAME_NORM, CANONICAL_EPISODE));
    const firstId = await seedEntity(entityInput('Hydra DB', 'hydra db', CANONICAL_EPISODE));
    const secondId = await seedEntity(entityInput('HydraStore', 'hydrastore', CANONICAL_EPISODE));
    const lateId = await seedEntity(entityInput('Hydra Cache', 'hydra cache', CANONICAL_EPISODE));

    await absorbInto(hostId, firstId, 'Hydra DB', ['Hydra DB']);
    await absorbInto(hostId, secondId, 'HydraStore', ['Hydra DB', 'HydraStore']);

    const report = await runEntityUnmerge(
      {
        driver: driverThatMergesAfterFirstRead(harness.driver, async () => {
          await absorbInto(hostId, lateId, 'Hydra Cache', [
            'Hydra DB',
            'HydraStore',
            'Hydra Cache',
          ]);
        }),
        db,
        logger,
      },
      { mergedId: firstId, now: LATER },
    );

    expect(report.status).toBe('applied');

    // The late merge's record is the only statement of what that identity contributed, so a
    // rewrite off the pre-transaction read would erase it along with the alias it absorbed.
    const remaining = await listUnmergeableRecords(harness.driver, hostId);
    expect(remaining.map((record) => record.mergedId)).toEqual([secondId, lateId]);

    const host = await storedEntity(harness.driver, hostId);
    expect(host?.aliases).toEqual(expect.arrayContaining(['HydraStore', 'Hydra Cache']));
    expect(host?.aliases).not.toContain('Hydra DB');
  }, 120_000);
});

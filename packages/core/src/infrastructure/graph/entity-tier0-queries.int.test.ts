import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { forgetNode, supersede, writeStampedNode } from './bitemporal.js';
import {
  countTier0EligibleEntities,
  findAliasEqualityPairs,
  findSquashEqualityGroups,
} from './entity-tier0-queries.js';
import { runGraphMigrations } from './migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { squashName } from '../../reflection/domain/entity-reconciliation.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

/**
 * Tier 0's two deterministic readings, against a real server. Both are identity predicates and
 * both turn on currency and on properties the write path stamps, so neither is provable against
 * a hand-written double.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-09-01T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

type EntitySeed = {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly structural?: boolean;
};

async function entity(seed: EntitySeed): Promise<void> {
  const nameNorm = seed.name.toLowerCase();
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: seed.id,
    now: NOW,
    properties: {
      name: seed.name,
      name_norm: nameNorm,
      name_squash: squashName(nameNorm),
      type: 'tool',
      aliases: [...(seed.aliases ?? [])],
      aliases_norm: (seed.aliases ?? []).map((alias) => alias.toLowerCase()),
      ...(seed.structural === true ? { structural: true } : {}),
    },
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-tier0-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 120_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('findSquashEqualityGroups', () => {
  it('groups the separator variants of one name and leaves everything else alone', async () => {
    await entity({ id: 'sq-a', name: 're-mark' });
    await entity({ id: 'sq-b', name: 'remark' });
    await entity({ id: 'sq-c', name: 'remarkable' });

    const groups = await findSquashEqualityGroups(harness.driver, { limit: 50 });

    const group = groups.find((candidate) => candidate.ids.includes('sq-a'));
    expect(group?.ids).toEqual(['sq-a', 'sq-b']);
    expect(groups.flatMap((candidate) => candidate.ids)).not.toContain('sq-c');
  }, 60_000);

  it('never groups two instance names that differ only in the digits they carry', async () => {
    await entity({ id: 'sq-d1', name: 'beta-episode-1' });
    await entity({ id: 'sq-d2', name: 'beta episode 2' });

    const groups = await findSquashEqualityGroups(harness.driver, { limit: 50 });

    expect(groups.flatMap((group) => group.ids)).not.toContain('sq-d1');
  }, 60_000);

  it('drops a group whose second side has lost currency', async () => {
    await entity({ id: 'sq-live', name: 'aion-local' });
    await entity({ id: 'sq-closed', name: 'aion local' });
    await supersede(harness.driver, { oldId: 'sq-closed', newId: 'sq-live', now: NOW });

    const groups = await findSquashEqualityGroups(harness.driver, { limit: 50 });

    expect(groups.flatMap((group) => group.ids)).not.toContain('sq-closed');
  }, 60_000);

  it('drops a group whose second side has been forgotten', async () => {
    await entity({ id: 'sq-kept', name: 'stripe-webhook' });
    await entity({ id: 'sq-gone', name: 'stripe webhook' });
    await forgetNode(harness.driver, { id: 'sq-gone', now: NOW });

    const groups = await findSquashEqualityGroups(harness.driver, { limit: 50 });

    expect(groups.flatMap((group) => group.ids)).not.toContain('sq-gone');
  }, 60_000);

  it('returns only the groups a named subject belongs to when the caller scopes it', async () => {
    await entity({ id: 'sq-x1', name: 'foo-bar' });
    await entity({ id: 'sq-x2', name: 'foo bar' });

    const scoped = await findSquashEqualityGroups(harness.driver, {
      subjectIds: ['sq-x1'],
      limit: 50,
    });

    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.ids).toEqual(['sq-x1', 'sq-x2']);
  }, 60_000);
});

describe('findAliasEqualityPairs', () => {
  it('pairs the holder of an alias with the identity that answers to it by name', async () => {
    await entity({ id: 'al-holder', name: 'Postgres', aliases: ['pgsql'] });
    await entity({ id: 'al-owner', name: 'pgsql' });

    const pairs = await findAliasEqualityPairs(harness.driver, { limit: 50 });

    expect(pairs).toEqual(
      expect.arrayContaining([{ holderId: 'al-holder', ownerId: 'al-owner', aliasKey: 'pgsql' }]),
    );
  }, 60_000);

  it('refuses an alias two identities both claim', async () => {
    await entity({ id: 'al-two-a', name: 'Datadog', aliases: ['dd'] });
    await entity({ id: 'al-two-b', name: 'Due Diligence', aliases: ['dd'] });
    await entity({ id: 'al-two-owner', name: 'dd' });

    const pairs = await findAliasEqualityPairs(harness.driver, { limit: 50 });

    expect(pairs.map((pair) => pair.ownerId)).not.toContain('al-two-owner');
  }, 60_000);

  it('refuses an alias whose only other holder has lost currency', async () => {
    await entity({ id: 'al-live', name: 'Valkey', aliases: ['vk'] });
    await entity({ id: 'al-dead-owner', name: 'vk' });
    await supersede(harness.driver, { oldId: 'al-dead-owner', newId: 'al-live', now: NOW });

    const pairs = await findAliasEqualityPairs(harness.driver, { limit: 50 });

    expect(pairs.map((pair) => pair.ownerId)).not.toContain('al-dead-owner');
  }, 60_000);

  it('scopes to the subjects the caller names, on either side of the pair', async () => {
    await entity({ id: 'al-scope-holder', name: 'Redis', aliases: ['rds'] });
    await entity({ id: 'al-scope-owner', name: 'rds' });

    const byOwner = await findAliasEqualityPairs(harness.driver, {
      subjectIds: ['al-scope-owner'],
      limit: 50,
    });
    const unrelated = await findAliasEqualityPairs(harness.driver, {
      subjectIds: ['al-holder'],
      limit: 50,
    });

    expect(byOwner.map((pair) => pair.holderId)).toEqual(['al-scope-holder']);
    expect(unrelated.map((pair) => pair.holderId)).not.toContain('al-scope-holder');
  }, 60_000);
});

describe('countTier0EligibleEntities', () => {
  /**
   * The relevance reading behind the graph-wide sweep. It counts identities rather than groups
   * and it counts them distinctly, so a name reachable through both readings is one merge
   * waiting to happen rather than two.
   */
  it('rises by the identities a new duplicate spelling adds', async () => {
    const before = await countTier0EligibleEntities(harness.driver, { limit: 500 });

    await entity({ id: 'cnt-a', name: 'flag-day' });
    await entity({ id: 'cnt-b', name: 'flag_day' });

    const after = await countTier0EligibleEntities(harness.driver, { limit: 500 });

    expect(after).toBe(before + 2);
  }, 60_000);

  it('counts nothing for a name no other identity shares', async () => {
    const before = await countTier0EligibleEntities(harness.driver, { limit: 500 });

    await entity({ id: 'cnt-lonely', name: 'Zephyr Ingest' });

    expect(await countTier0EligibleEntities(harness.driver, { limit: 500 })).toBe(before);
  }, 60_000);
});

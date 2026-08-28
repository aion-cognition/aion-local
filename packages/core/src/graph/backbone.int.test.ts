import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapBackbone, GLOBAL_WORKSPACE_NAME } from './backbone.js';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { runGraphMigrations } from './migrations.js';
import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-01-01T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-backbone-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function countLabel(label: 'Member' | 'Workspace'): Promise<number> {
  const rows = await runRead(harness.driver, `MATCH (n:${label}) RETURN count(n) AS c`, {}, (row) => row.c as number);
  return rows[0] ?? 0;
}

async function nodeProperty(label: 'Member' | 'Workspace', property: string): Promise<unknown> {
  const rows = await runRead(harness.driver, `MATCH (n:${label}) RETURN n.\`${property}\` AS value`, {}, (row) => row.value);
  return rows[0];
}

async function memberId(): Promise<string | undefined> {
  const rows = await runRead(harness.driver, 'MATCH (n:Member) RETURN n.id AS id', {}, (row) => row.id as string);
  return rows[0];
}

describe('backbone bootstrap', () => {
  it('creates exactly one Member and one Workspace, labeled, structural, and bitemporally stamped', async () => {
    const result = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber', now: NOW });

    expect([...result.member.labels].sort()).toEqual([BASE_NODE_LABEL, 'Entity', 'Member'].sort());
    expect([...result.workspace.labels].sort()).toEqual([BASE_NODE_LABEL, 'Entity', 'Workspace'].sort());
    expect(result.member.created).toBe(true);
    expect(result.workspace.created).toBe(true);
    expect(await countLabel('Member')).toBe(1);
    expect(await countLabel('Workspace')).toBe(1);

    expect(await nodeProperty('Member', 'name')).toBe('Ryan Huber');
    expect(await nodeProperty('Member', 'name_norm')).toBe('ryan huber');
    expect(await nodeProperty('Member', 'is_structural')).toBe(true);
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.occurredAt)).toEqual(NOW);
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.validFrom)).toEqual(NOW);
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.txFrom)).toEqual(NOW);
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.validUntil)).toBeNull();
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.txUntil)).toBeNull();

    expect(await nodeProperty('Workspace', 'name')).toBe(GLOBAL_WORKSPACE_NAME);
    expect(await nodeProperty('Workspace', 'name_norm')).toBe(GLOBAL_WORKSPACE_NAME);
    expect(await nodeProperty('Workspace', 'is_structural')).toBe(true);
    expect(await nodeProperty('Workspace', BITEMPORAL_PROPERTIES.validUntil)).toBeNull();
  });

  it('running it again is a no-op: still one node each, and both report unmatched-not-created', async () => {
    const rerun = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber', now: new Date('2026-06-06T00:00:00.000Z') });

    expect(rerun.member.created).toBe(false);
    expect(rerun.workspace.created).toBe(false);
    expect(await countLabel('Member')).toBe(1);
    expect(await countLabel('Workspace')).toBe(1);
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.txFrom)).toEqual(NOW);
  });

  it('collapses whitespace in the stored name and keeps the case the user typed', async () => {
    const rerun = await bootstrapBackbone(harness.driver, { memberName: '  RYAN   Huber ' });

    expect(rerun.member.created).toBe(false);
    expect(await countLabel('Member')).toBe(1);
    expect(await nodeProperty('Member', 'name')).toBe('RYAN Huber');
    expect(await nodeProperty('Member', 'name_norm')).toBe('ryan huber');
  });

  it('renames the one Member on a corrected name instead of forking the backbone', async () => {
    const before = await memberId();

    const renamed = await bootstrapBackbone(harness.driver, { memberName: 'rhuber' });

    expect(renamed.member.created).toBe(false);
    expect(renamed.member.id).toBe(before);
    expect(await countLabel('Member')).toBe(1);
    expect(await nodeProperty('Member', 'name')).toBe('rhuber');
    expect(await nodeProperty('Member', 'name_norm')).toBe('rhuber');
    expect(await nodeProperty('Member', BITEMPORAL_PROPERTIES.txFrom)).toEqual(NOW);
  });
});

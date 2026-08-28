import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_NODE_LABEL } from './labels.js';
import {
  GRAPH_MIGRATIONS,
  graphMigrationMetaKey,
  latestAppliedGraphMigration,
  runGraphMigrations,
} from './migrations.js';
import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from './test-support/neo4j-harness.fixture.js';
import { getMeta } from '../sqlite/meta.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 768;

const EXPECTED_CONSTRAINTS = [
  { name: 'aion_node_id_unique', labelsOrTypes: [BASE_NODE_LABEL], properties: ['id'] },
  { name: 'entity_name_type_unique', labelsOrTypes: ['Entity'], properties: ['name_norm', 'type'] },
  { name: 'episode_id_unique', labelsOrTypes: ['Episode'], properties: ['id'] },
  { name: 'member_id_unique', labelsOrTypes: ['Member'], properties: ['id'] },
  { name: 'session_id_unique', labelsOrTypes: ['Session'], properties: ['id'] },
  { name: 'turn_id_unique', labelsOrTypes: ['Turn'], properties: ['id'] },
  { name: 'workspace_id_unique', labelsOrTypes: ['Workspace'], properties: ['id'] },
].sort((a, b) => a.name.localeCompare(b.name));

const EXPECTED_NON_LOOKUP_INDEXES = [
  ...EXPECTED_CONSTRAINTS.map((c) => ({ name: c.name, type: 'RANGE', labelsOrTypes: c.labelsOrTypes, properties: c.properties })),
  { name: 'content_vec_idx', type: 'VECTOR', labelsOrTypes: ['Memory'], properties: ['content_vec'] },
  { name: 'context_vec_idx', type: 'VECTOR', labelsOrTypes: ['Memory'], properties: ['context_vec'] },
  { name: 'memory_valid_until_idx', type: 'RANGE', labelsOrTypes: ['Memory'], properties: ['valid_until'] },
  { name: 'memory_tx_until_idx', type: 'RANGE', labelsOrTypes: ['Memory'], properties: ['tx_until'] },
  { name: 'content_fts', type: 'FULLTEXT', labelsOrTypes: ['Episode', 'Turn', 'Entity'], properties: ['summary', 'text', 'name'] },
].sort((a, b) => a.name.localeCompare(b.name));

type ConstraintRow = { name: string; labelsOrTypes: string[]; properties: string[] };
type IndexRow = { name: string; type: string; labelsOrTypes: string[] | null; properties: string[] | null; options: { indexConfig?: Record<string, unknown> } };

async function fetchConstraints(harness: Neo4jHarness): Promise<ConstraintRow[]> {
  const result = await harness.driver.executeQuery('SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties RETURN name, labelsOrTypes, properties');
  return result.records
    .map((r) => ({
      name: r.get('name') as string,
      labelsOrTypes: r.get('labelsOrTypes') as string[],
      properties: r.get('properties') as string[],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchNonLookupIndexes(harness: Neo4jHarness): Promise<IndexRow[]> {
  const result = await harness.driver.executeQuery(
    "SHOW INDEXES YIELD name, type, labelsOrTypes, properties, options WHERE type <> 'LOOKUP' RETURN name, type, labelsOrTypes, properties, options",
  );
  return result.records
    .map((r) => ({
      name: r.get('name') as string,
      type: r.get('type') as string,
      labelsOrTypes: r.get('labelsOrTypes') as string[] | null,
      properties: r.get('properties') as string[] | null,
      options: r.get('options') as { indexConfig?: Record<string, unknown> },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('graph schema migration 001', () => {
  let harness: Neo4jHarness;
  let db: SqliteHandle;
  let dir: string;

  beforeAll(async () => {
    harness = await startNeo4jHarness();
    dir = mkdtempSync(join(tmpdir(), 'aion-graph-migrations-'));
    db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
  });

  afterAll(async () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await stopNeo4jHarness(harness);
  });

  it('applies migration 001 on first run and records it in the meta table', async () => {
    expect(latestAppliedGraphMigration(db)).toBeUndefined();

    const { applied, created } = await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

    expect(applied).toEqual([1]);
    expect(created).toContain('content_vec_idx');
    expect(created).toContain('aion_node_id_unique');
    expect(getMeta(db, graphMigrationMetaKey(1))).toBeDefined();
    expect(latestAppliedGraphMigration(db)).toBe(1);
  });

  it('creates exactly the pinned constraints', async () => {
    const constraints = await fetchConstraints(harness);
    expect(constraints).toEqual(EXPECTED_CONSTRAINTS);
  });

  it('creates exactly the pinned non-lookup indexes, with the vector indexes at the configured dimension', async () => {
    const indexes = await fetchNonLookupIndexes(harness);

    expect(indexes.map(({ name, type, labelsOrTypes, properties }) => ({ name, type, labelsOrTypes, properties }))).toEqual(
      EXPECTED_NON_LOOKUP_INDEXES,
    );

    const contentVec = indexes.find((i) => i.name === 'content_vec_idx');
    const contextVec = indexes.find((i) => i.name === 'context_vec_idx');
    const dimensionsOf = (row: IndexRow | undefined): number =>
      (row?.options.indexConfig?.['vector.dimensions'] as { toNumber(): number }).toNumber();

    expect(dimensionsOf(contentVec)).toBe(EMBED_DIMENSION);
    expect(contentVec?.options.indexConfig?.['vector.similarity_function']).toBe('COSINE');
    expect(dimensionsOf(contextVec)).toBe(EMBED_DIMENSION);
  });

  it('re-running is a no-op: nothing applied, nothing created, and the schema is unchanged', async () => {
    const constraintsBefore = await fetchConstraints(harness);
    const indexesBefore = await fetchNonLookupIndexes(harness);

    const { applied, created } = await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

    expect(applied).toEqual([]);
    expect(created).toEqual([]);
    expect(await fetchConstraints(harness)).toEqual(constraintsBefore);
    expect(await fetchNonLookupIndexes(harness)).toEqual(indexesBefore);
  });

  it('repairs a graph that lost schema objects while the meta table survived', async () => {
    await harness.driver.executeQuery('DROP CONSTRAINT episode_id_unique');
    await harness.driver.executeQuery('DROP INDEX content_vec_idx');

    const { applied, created } = await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

    expect(applied).toEqual([]);
    expect([...created].sort()).toEqual(['content_vec_idx', 'episode_id_unique']);
    expect(await fetchConstraints(harness)).toEqual(EXPECTED_CONSTRAINTS);
    expect(
      (await fetchNonLookupIndexes(harness)).map(({ name, type, labelsOrTypes, properties }) => ({
        name,
        type,
        labelsOrTypes,
        properties,
      })),
    ).toEqual(EXPECTED_NON_LOOKUP_INDEXES);
  });

  it('the pinned migration list is exactly migration 001 for P0', () => {
    expect(GRAPH_MIGRATIONS.map((m) => m.version)).toEqual([1]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_NODE_LABEL } from './labels.js';
import {
  appliedGraphSchemaVersion,
  GRAPH_SCHEMA_VERSION,
  runGraphMigrations,
} from './migrations.js';
import { CONTENT_FULLTEXT_INDEX } from './seed-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 768;

const EXPECTED_CONSTRAINTS = [
  { name: 'aion_node_id_unique', labelsOrTypes: [BASE_NODE_LABEL], properties: ['id'] },
  { name: 'bridge_id_unique', labelsOrTypes: ['Bridge'], properties: ['id'] },
  { name: 'concept_id_unique', labelsOrTypes: ['Concept'], properties: ['id'] },
  { name: 'context_id_unique', labelsOrTypes: ['Context'], properties: ['id'] },
  { name: 'decision_id_unique', labelsOrTypes: ['Decision'], properties: ['id'] },
  { name: 'entity_name_unique', labelsOrTypes: ['Entity'], properties: ['name_norm'] },
  { name: 'episode_id_unique', labelsOrTypes: ['Episode'], properties: ['id'] },
  { name: 'event_id_unique', labelsOrTypes: ['Event'], properties: ['id'] },
  { name: 'goal_id_unique', labelsOrTypes: ['Goal'], properties: ['id'] },
  { name: 'insight_id_unique', labelsOrTypes: ['Insight'], properties: ['id'] },
  { name: 'member_id_unique', labelsOrTypes: ['Member'], properties: ['id'] },
  { name: 'narrative_id_unique', labelsOrTypes: ['Narrative'], properties: ['id'] },
  { name: 'pattern_id_unique', labelsOrTypes: ['Pattern'], properties: ['id'] },
  { name: 'plan_id_unique', labelsOrTypes: ['Plan'], properties: ['id'] },
  {
    name: 'publication_guard_substrate_id_unique',
    labelsOrTypes: ['PublicationGuard'],
    properties: ['substrate_id'],
  },
  { name: 'session_id_unique', labelsOrTypes: ['Session'], properties: ['id'] },
  { name: 'substrate_id_unique', labelsOrTypes: ['Substrate'], properties: ['id'] },
  { name: 'trend_id_unique', labelsOrTypes: ['Trend'], properties: ['id'] },
  { name: 'turn_id_unique', labelsOrTypes: ['Turn'], properties: ['id'] },
  { name: 'workspace_id_unique', labelsOrTypes: ['Workspace'], properties: ['id'] },
].sort((a, b) => a.name.localeCompare(b.name));

const EXPECTED_NON_LOOKUP_INDEXES = [
  ...EXPECTED_CONSTRAINTS.map((c) => ({
    name: c.name,
    type: 'RANGE',
    labelsOrTypes: c.labelsOrTypes,
    properties: c.properties,
  })),
  {
    name: 'entity_name_squash_idx',
    type: 'RANGE',
    labelsOrTypes: ['Entity'],
    properties: ['name_squash'],
  },
  {
    name: 'content_vec_idx',
    type: 'VECTOR',
    labelsOrTypes: ['Memory'],
    properties: ['content_vec'],
  },
  {
    name: 'context_vec_idx',
    type: 'VECTOR',
    labelsOrTypes: ['Memory'],
    properties: ['context_vec'],
  },
  {
    name: 'memory_valid_until_idx',
    type: 'RANGE',
    labelsOrTypes: ['Memory'],
    properties: ['valid_until'],
  },
  {
    name: 'memory_tx_until_idx',
    type: 'RANGE',
    labelsOrTypes: ['Memory'],
    properties: ['tx_until'],
  },
  {
    name: 'claim_subject_aspect_idx',
    type: 'RANGE',
    labelsOrTypes: ['Memory'],
    properties: ['subject_entity_id', 'aspect_norm'],
  },
  {
    name: CONTENT_FULLTEXT_INDEX,
    type: 'FULLTEXT',
    labelsOrTypes: [
      'Episode',
      'Turn',
      'Entity',
      'Narrative',
      'Goal',
      'Plan',
      'Decision',
      'Insight',
      'Concept',
      'Context',
      'Event',
      'Pattern',
      'Trend',
    ],
    properties: ['summary', 'text', 'name'],
  },
].sort((a, b) => a.name.localeCompare(b.name));

type ConstraintRow = { name: string; labelsOrTypes: string[]; properties: string[] };
type IndexRow = {
  name: string;
  id: number;
  type: string;
  labelsOrTypes: string[] | null;
  properties: string[] | null;
  options: { indexConfig?: Record<string, unknown> };
};

async function fetchConstraints(harness: Neo4jHarness): Promise<ConstraintRow[]> {
  const result = await harness.driver.executeQuery(
    'SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties RETURN name, labelsOrTypes, properties',
  );
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
    "SHOW INDEXES YIELD name, id, type, labelsOrTypes, properties, options WHERE type <> 'LOOKUP' RETURN name, id, type, labelsOrTypes, properties, options",
  );
  return result.records
    .map((r) => ({
      name: r.get('name') as string,
      id: (r.get('id') as { toNumber(): number }).toNumber(),
      type: r.get('type') as string,
      labelsOrTypes: r.get('labelsOrTypes') as string[] | null,
      properties: r.get('properties') as string[] | null,
      options: r.get('options') as { indexConfig?: Record<string, unknown> },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('the graph schema', () => {
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

  it('records the schema version on the first run and answers with it after', async () => {
    expect(appliedGraphSchemaVersion(db)).toBeUndefined();

    const outcome = await runGraphMigrations(harness.driver, db, {
      embedDimension: EMBED_DIMENSION,
    });

    expect(outcome.applied).toBe(true);
    expect(appliedGraphSchemaVersion(db)).toBe(GRAPH_SCHEMA_VERSION);
  });

  it('creates exactly the pinned constraints, including one id constraint per new cognitive label', async () => {
    const constraints = await fetchConstraints(harness);
    expect(constraints).toEqual(EXPECTED_CONSTRAINTS);
  });

  it('creates exactly the pinned non-lookup indexes, the fulltext one over every memory label', async () => {
    const indexes = await fetchNonLookupIndexes(harness);

    expect(
      indexes.map(({ name, type, labelsOrTypes, properties }) => ({
        name,
        type,
        labelsOrTypes,
        properties,
      })),
    ).toEqual(EXPECTED_NON_LOOKUP_INDEXES);

    const contentVec = indexes.find((i) => i.name === 'content_vec_idx');
    const contextVec = indexes.find((i) => i.name === 'context_vec_idx');
    const dimensionsOf = (row: IndexRow | undefined): number =>
      (row?.options.indexConfig?.['vector.dimensions'] as { toNumber(): number }).toNumber();

    expect(dimensionsOf(contentVec)).toBe(EMBED_DIMENSION);
    expect(contentVec?.options.indexConfig?.['vector.similarity_function']).toBe('COSINE');
    expect(dimensionsOf(contextVec)).toBe(EMBED_DIMENSION);
  });

  it('re-running is a no-op: nothing newly applied, nothing newly created, and the schema is unchanged', async () => {
    const constraintsBefore = await fetchConstraints(harness);
    const indexesBefore = await fetchNonLookupIndexes(harness);

    const { applied, created } = await runGraphMigrations(harness.driver, db, {
      embedDimension: EMBED_DIMENSION,
    });

    expect(applied).toBe(false);
    expect(created).toEqual([]);
    expect(await fetchConstraints(harness)).toEqual(constraintsBefore);
    // Index ids are compared too: a drop-and-recreate reaches the same end state under a new
    // id, and that churn on an already-healthy index is what this guards against.
    expect(await fetchNonLookupIndexes(harness)).toEqual(indexesBefore);
  });

  it('leaves the fulltext index itself untouched across three inits', async () => {
    const idOf = async (): Promise<number | undefined> =>
      (await fetchNonLookupIndexes(harness)).find((index) => index.name === CONTENT_FULLTEXT_INDEX)
        ?.id;
    const before = await idOf();

    await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
    await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

    expect(before).toBeDefined();
    expect(await idOf()).toBe(before);
  });

  async function fulltextIds(term: string): Promise<string[]> {
    const result = await harness.driver.executeQuery(
      'CALL db.index.fulltext.queryNodes($index, $term) YIELD node RETURN node.id AS id',
      { index: CONTENT_FULLTEXT_INDEX, term },
    );
    return result.records.map((r) => r.get('id') as string);
  }

  it('repairs a graph that lost schema objects while the meta table survived', async () => {
    await harness.driver.executeQuery('DROP CONSTRAINT episode_id_unique');
    await harness.driver.executeQuery('DROP CONSTRAINT goal_id_unique');
    await harness.driver.executeQuery('DROP INDEX content_vec_idx');

    const { applied, created } = await runGraphMigrations(harness.driver, db, {
      embedDimension: EMBED_DIMENSION,
    });

    expect(applied).toBe(false);
    expect([...created].sort()).toEqual(['content_vec_idx', 'episode_id_unique', 'goal_id_unique']);
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

  it('covers Narrative.summary and the cognitive types shared text property', async () => {
    await harness.driver.executeQuery(
      `CREATE (n:Narrative:Memory:${BASE_NODE_LABEL} {id: $id, summary: $summary})`,
      { id: 'narrative-fixture', summary: 'weekly consolidation touching trundlewick' },
    );
    await harness.driver.executeQuery(
      `CREATE (n:Goal:Memory:${BASE_NODE_LABEL} {id: $id, text: $text})`,
      { id: 'goal-fixture', text: 'ship the flangemarch cutover by end of quarter' },
    );
    await harness.driver.executeQuery('CALL db.awaitIndexes(60)');

    expect(await fulltextIds('trundlewick')).toContain('narrative-fixture');
    expect(await fulltextIds('flangemarch')).toContain('goal-fixture');
  });
});

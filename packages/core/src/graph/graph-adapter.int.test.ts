import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { BITEMPORAL_PROPERTIES, supersede, writeStampedNode } from './bitemporal.js';
import { GraphConnection, runRead, runWrite } from './connection.js';
import { buildEdgeUpsert, upsertEdge } from './edges.js';
import { GraphNodeNotFoundError } from './errors.js';
import { BASE_NODE_LABEL } from './labels.js';
import { runGraphMigrations } from './migrations.js';
import {
  asOf,
  knewAt,
  readCurrencyAnnotation,
  readModeFragment,
  withCurrency,
  type CurrencyAnnotation,
  type ReadMode,
} from './read-modes.js';
import { startNeo4jHarness, stopNeo4jHarness, type Neo4jHarness } from './test-support/neo4j-harness.fixture.js';
import { toGraphDateTime, toGraphVector } from './values.js';

const EMBED_DIMENSION = 8;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-graph-adapter-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type AnnotatedRow = CurrencyAnnotation & { id: string };

/**
 * The composition pattern P2's seed strategies and traversal follow: build the fragment,
 * AND its predicate into the WHERE, splice its projection into the RETURN, spread its
 * parameters alongside the query's own.
 */
async function readEpisodes(mode: ReadMode, ids: readonly string[]): Promise<AnnotatedRow[]> {
  const fragment = readModeFragment(mode, 'n');
  const cypher = [
    'MATCH (n:Episode)',
    `WHERE n.id IN $ids AND ${fragment.where}`,
    `RETURN n.id AS id, ${fragment.projection}`,
    'ORDER BY id',
  ].join('\n');
  return runRead(harness.driver, cypher, { ...fragment.parameters, ids: [...ids] }, (row) => ({
    id: row.id as string,
    ...readCurrencyAnnotation(row),
  }));
}

async function countNodes(id: string): Promise<number> {
  const rows = await runRead(harness.driver, 'MATCH (n { id: $id }) RETURN count(n) AS c', { id }, (row) => row.c as number);
  return rows[0] ?? 0;
}

async function countEdges(type: string, a: string, b: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    `MATCH ({ id: $a })-[r:${type}]-({ id: $b }) RETURN count(DISTINCT r) AS c`,
    { a, b },
    (row) => row.c as number,
  );
  return rows[0] ?? 0;
}

type PlanNode = { operatorType: string; children: readonly PlanNode[] };

/** The driver suffixes each operator with the database it planned against (`Projection@neo4j`). */
function planOperators(plan: PlanNode): string[] {
  return [plan.operatorType.split('@')[0] ?? plan.operatorType, ...plan.children.flatMap(planOperators)];
}

async function explainOperators(cypher: string, parameters: Record<string, unknown>): Promise<string[]> {
  const result = await harness.driver.executeQuery(`EXPLAIN ${cypher}`, parameters);
  const plan = result.summary.plan as unknown as PlanNode | false;
  if (plan === false) {
    throw new Error('the server returned no plan for the statement');
  }
  return planOperators(plan);
}

async function nodeProperty(id: string, property: string): Promise<unknown> {
  const rows = await runRead(
    harness.driver,
    `MATCH (n { id: $id }) RETURN n.\`${property}\` AS value`,
    { id },
    (row) => row.value,
  );
  return rows[0];
}

describe('node writes', () => {
  it('is a no-op the second time, stamps intact', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'node-idempotent',
      now,
      properties: { summary: 'first' },
    });
    const second = await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'node-idempotent',
      now: new Date('2026-06-06T00:00:00.000Z'),
      properties: { summary: 'second' },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await countNodes('node-idempotent')).toBe(1);
    expect(await nodeProperty('node-idempotent', 'summary')).toBe('first');
    expect(await nodeProperty('node-idempotent', BITEMPORAL_PROPERTIES.txFrom)).toEqual(now);
  });

  it('leaves both timelines open', async () => {
    await writeStampedNode(harness.driver, { label: 'Episode', id: 'node-open' });
    expect(await nodeProperty('node-open', BITEMPORAL_PROPERTIES.validUntil)).toBeNull();
    expect(await nodeProperty('node-open', BITEMPORAL_PROPERTIES.txUntil)).toBeNull();
  });

  it('applies the companion labels the schema objects depend on', async () => {
    const episode = await writeStampedNode(harness.driver, { label: 'Episode', id: 'node-labels-episode' });
    const member = await writeStampedNode(harness.driver, {
      label: 'Member',
      id: 'node-labels-member',
      properties: { name_norm: 'ryan', type: 'member' },
      mergeProperties: { is_structural: true },
    });
    expect([...episode.labels].sort()).toEqual([BASE_NODE_LABEL, 'Episode', 'Memory'].sort());
    expect([...member.labels].sort()).toEqual([BASE_NODE_LABEL, 'Entity', 'Member'].sort());
    expect(await nodeProperty('node-labels-member', 'is_structural')).toBe(true);
  });

  it('applies merge properties to a node that already exists', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Member',
      id: 'node-upgrade',
      properties: { name_norm: 'organic', type: 'member' },
    });
    expect(await nodeProperty('node-upgrade', 'is_structural')).toBeNull();

    const upgraded = await writeStampedNode(harness.driver, {
      label: 'Member',
      id: 'node-upgrade',
      properties: { name_norm: 'organic', type: 'member' },
      mergeProperties: { is_structural: true },
    });
    expect(upgraded.created).toBe(false);
    expect(await nodeProperty('node-upgrade', 'is_structural')).toBe(true);
  });

  it('puts content-bearing nodes into the shared vector index', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'node-vector',
      properties: { summary: 'vector carrier', content_vec: toGraphVector([1, 0, 0, 0, 0, 0, 0, 0]) },
    });
    await runWrite(harness.driver, 'CALL db.awaitIndexes(60)', {}, (row) => row);
    const hits = await runRead(
      harness.driver,
      'CALL db.index.vector.queryNodes("content_vec_idx", 5, $q) YIELD node, score RETURN node.id AS id, score',
      { q: toGraphVector([1, 0, 0, 0, 0, 0, 0, 0]) },
      (row) => ({ id: row.id as string, score: row.score as number }),
    );
    expect(hits.map((hit) => hit.id)).toContain('node-vector');
  });
});

describe('edge merge policy', () => {
  beforeAll(async () => {
    for (const id of ['edge-a', 'edge-b', 'edge-c']) {
      await writeStampedNode(harness.driver, { label: 'Episode', id });
    }
  });

  it('collapses a repeated write into one edge and converges every policy field', async () => {
    const first = await upsertEdge(harness.driver, {
      type: 'MENTIONS',
      sourceId: 'edge-a',
      targetId: 'edge-b',
      strength: 0.4,
      confidence: 0.9,
      signals: ['episodic'],
      provenance: ['intake'],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await upsertEdge(harness.driver, {
      type: 'MENTIONS',
      sourceId: 'edge-a',
      targetId: 'edge-b',
      strength: 0.7,
      confidence: 0.2,
      signals: ['semantic'],
      provenance: ['intake', 'reflection'],
      now: new Date('2026-02-02T00:00:00.000Z'),
    });

    expect(await countEdges('MENTIONS', 'edge-a', 'edge-b')).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.strength).toBe(0.7);
    expect(second.confidence).toBe(0.9);
    expect([...second.signals].sort()).toEqual(['episodic', 'semantic']);
    expect([...second.provenance].sort()).toEqual(['intake', 'reflection']);
    expect(second.count).toBe(2);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it('keeps the maximum when a weaker observation arrives later', async () => {
    const strong = await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: 'edge-a',
      targetId: 'edge-c',
      strength: 0.9,
      confidence: 0.8,
      signals: ['semantic'],
      provenance: ['reflection'],
    });
    const weak = await upsertEdge(harness.driver, {
      type: 'RELATED_TO',
      sourceId: 'edge-a',
      targetId: 'edge-c',
      strength: 0.1,
      confidence: 0.1,
      signals: ['semantic'],
      provenance: ['reflection'],
    });
    expect(weak.strength).toBe(strong.strength);
    expect(weak.confidence).toBe(strong.confidence);
    expect([...weak.signals]).toEqual(['semantic']);
  });

  it('writes one edge for an undirected type however the endpoints are ordered', async () => {
    await upsertEdge(harness.driver, {
      type: 'SIMILAR',
      sourceId: 'edge-b',
      targetId: 'edge-c',
      strength: 0.5,
      confidence: 0.5,
      signals: ['semantic'],
      provenance: ['reflection'],
      count: 0,
    });
    await upsertEdge(harness.driver, {
      type: 'SIMILAR',
      sourceId: 'edge-c',
      targetId: 'edge-b',
      strength: 0.5,
      confidence: 0.5,
      signals: ['semantic'],
      provenance: ['reflection'],
      count: 0,
    });
    expect(await countEdges('SIMILAR', 'edge-b', 'edge-c')).toBe(1);
  });

  it('seeks an index for both endpoints rather than scanning every node twice', async () => {
    const statement = buildEdgeUpsert({
      type: 'MENTIONS',
      sourceId: 'edge-a',
      targetId: 'edge-b',
      strength: 0.5,
      confidence: 0.5,
      signals: ['episodic'],
      provenance: ['intake'],
    });

    const operators = await explainOperators(statement.cypher, statement.parameters);

    expect(operators).not.toContain('AllNodesScan');
    expect(operators.filter((operator) => operator.startsWith('NodeUniqueIndexSeek'))).toHaveLength(2);
  });

  it('names the missing endpoint instead of silently writing nothing', async () => {
    await expect(
      upsertEdge(harness.driver, {
        type: 'MENTIONS',
        sourceId: 'edge-a',
        targetId: 'no-such-node',
        strength: 0.5,
        confidence: 0.5,
        signals: [],
        provenance: [],
      }),
    ).rejects.toBeInstanceOf(GraphNodeNotFoundError);
  });
});

describe('supersession', () => {
  const writtenAt = new Date('2026-01-10T00:00:00.000Z');
  const supersededAt = new Date('2026-03-10T00:00:00.000Z');

  beforeAll(async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'sup-old',
      now: writtenAt,
      occurredAt: writtenAt,
      properties: { summary: 'the old truth' },
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'sup-new',
      now: supersededAt,
      occurredAt: supersededAt,
      properties: { summary: 'the new truth' },
    });
    await supersede(harness.driver, { oldId: 'sup-old', newId: 'sup-new', now: supersededAt });
  });

  it('closes both timelines on the old node without deleting it', async () => {
    expect(await countNodes('sup-old')).toBe(1);
    expect(await nodeProperty('sup-old', BITEMPORAL_PROPERTIES.validUntil)).toEqual(supersededAt);
    expect(await nodeProperty('sup-old', BITEMPORAL_PROPERTIES.txUntil)).toEqual(supersededAt);
    expect(await nodeProperty('sup-old', 'summary')).toBe('the old truth');
  });

  it('is a total no-op on a second call', async () => {
    const repeat = await supersede(harness.driver, {
      oldId: 'sup-old',
      newId: 'sup-new',
      now: new Date('2026-09-09T00:00:00.000Z'),
    });
    expect(repeat.validUntil).toEqual(supersededAt);
    expect(repeat.txUntil).toEqual(supersededAt);
    expect(repeat.edge.count).toBe(0);
    expect(await countEdges('SUPERSEDES', 'sup-new', 'sup-old')).toBe(1);
  });

  it('rejects a supersession whose old node does not exist', async () => {
    await expect(
      supersede(harness.driver, { oldId: 'no-such-node', newId: 'sup-new' }),
    ).rejects.toBeInstanceOf(GraphNodeNotFoundError);
  });

  it('keeps the superseded node recall-eligible under the default read mode, marked with its lineage', async () => {
    const rows = await readEpisodes(withCurrency(), ['sup-old', 'sup-new']);
    expect(rows.map((row) => row.id)).toEqual(['sup-new', 'sup-old']);

    const current = rows.find((row) => row.id === 'sup-new');
    const superseded = rows.find((row) => row.id === 'sup-old');
    expect(current?.currency).toBe('current');
    expect(current?.supersededBy).toBeUndefined();
    expect(superseded?.currency).toBe('superseded');
    expect(superseded?.supersededBy?.id).toBe('sup-new');
    expect(superseded?.supersededBy?.at).toEqual(supersededAt);
  });

  it('returns the old truth as current-for-then under as_of', async () => {
    const before = new Date('2026-02-01T00:00:00.000Z');
    const rows = await readEpisodes(asOf(before), ['sup-old', 'sup-new']);
    expect(rows.map((row) => row.id)).toEqual(['sup-old']);
    expect(rows[0]?.currency).toBe('current');
    expect(rows[0]?.supersededBy?.id).toBe('sup-new');
  });

  it('returns the replacement under an as_of after the supersession', async () => {
    const after = new Date('2026-04-01T00:00:00.000Z');
    const rows = await readEpisodes(asOf(after), ['sup-old', 'sup-new']);
    expect(rows.map((row) => row.id)).toEqual(['sup-new']);
  });

  it('answers what the substrate knew at a moment under knew_at', async () => {
    const midway = await readEpisodes(knewAt(new Date('2026-02-01T00:00:00.000Z')), ['sup-old', 'sup-new']);
    expect(midway.map((row) => row.id)).toEqual(['sup-old']);

    const beforeAnything = await readEpisodes(knewAt(new Date('2026-01-01T00:00:00.000Z')), ['sup-old', 'sup-new']);
    expect(beforeAnything).toEqual([]);

    const afterBoth = await readEpisodes(knewAt(new Date('2026-04-01T00:00:00.000Z')), ['sup-old', 'sup-new']);
    expect(afterBoth.map((row) => row.id)).toEqual(['sup-new']);
  });

  it('marks what the substrate then believed as current, with no lineage it did not have yet', async () => {
    const midway = await readEpisodes(knewAt(new Date('2026-02-01T00:00:00.000Z')), ['sup-old']);
    expect(midway[0]?.currency).toBe('current');
    expect(midway[0]?.supersededBy).toBeUndefined();

    const afterBoth = await readEpisodes(knewAt(new Date('2026-04-01T00:00:00.000Z')), ['sup-new']);
    expect(afterBoth[0]?.currency).toBe('current');
  });
});

describe('forgetting', () => {
  const forgottenAt = new Date('2026-05-05T00:00:00.000Z');

  beforeAll(async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'forgotten-1',
      now: new Date('2026-01-01T00:00:00.000Z'),
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await runWrite(
      harness.driver,
      `MATCH (n { id: $id }) SET n.${BITEMPORAL_PROPERTIES.forgottenAt} = $at, n.${BITEMPORAL_PROPERTIES.validUntil} = $at`,
      { id: 'forgotten-1', at: toGraphDateTime(forgottenAt) },
      (row) => row,
    );
  });

  it('drops a forgotten node from the default read mode', async () => {
    expect(await readEpisodes(withCurrency(), ['forgotten-1'])).toEqual([]);
  });

  it('still surfaces it for time travel, so the audit trail survives', async () => {
    const rows = await readEpisodes(asOf(new Date('2026-02-01T00:00:00.000Z')), ['forgotten-1']);
    expect(rows.map((row) => row.id)).toEqual(['forgotten-1']);
    expect(await countNodes('forgotten-1')).toBe(1);
  });
});

describe('connection lifecycle', () => {
  it('reports a reachable server through the same check doctor runs', async () => {
    const connection = new GraphConnection({ uri: harness.uri, password: 'aion-test-harness-password' });
    try {
      const health = await connection.health();
      expect(health.reachable).toBe(true);
      expect(health.address).toBeTruthy();
      const rows = await connection.read('RETURN 1 AS one', {}, (row) => row.one as number);
      expect(rows).toEqual([1]);
    } finally {
      await connection.close();
    }
  });
});

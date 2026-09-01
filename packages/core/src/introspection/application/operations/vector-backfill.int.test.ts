import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { vectorBackfillOperation } from './vector-backfill.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { vectorInputHash } from '../../../reflection/domain/vector-input.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const LATER = new Date('2026-08-29T14:15:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  ollama: { ...DEFAULTS.ollama, url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434' },
  maintenance: { ...DEFAULTS.maintenance, vectorBackfillBatchSize: 2, contextRefreshBatchSize: 5 },
};

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-vector-backfill-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctxFor(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('vector_backfill: content vector pass', () => {
  it('embeds pending memory nodes, bounded by the configured batch size', async () => {
    for (const id of ['content-a', 'content-b', 'content-c']) {
      await writeStampedNode(harness.driver, {
        label: 'Episode',
        id,
        properties: { text: `body of ${id}` },
        now: NOW,
      });
    }

    const operation = vectorBackfillOperation();
    const first = await operation.run(ctxFor());

    // Batch size is 2: exactly two of the three pending nodes are embedded this run, no more.
    expect(first.status).toBe('applied');
    expect(first.itemsAffected).toBe(2);

    const second = await operation.run(ctxFor({ now: LATER }));
    // The remaining node (and nothing else) is picked up on the next run.
    expect(second.status).toBe('applied');
    expect(second.itemsAffected).toBe(1);

    for (const id of ['content-a', 'content-b', 'content-c']) {
      const props = await nodeProperties(harness.driver, id);
      expect(Array.isArray(props.content_vec)).toBe(true);
      expect((props.content_vec as number[]).length).toBe(EMBED_DIMENSION);
    }

    const third = await operation.run(ctxFor({ now: LATER }));
    // Nothing pending and no drifted context left after two runs: idempotent.
    expect(third.itemsAffected).toBe(0);
  }, 60_000);
});

/** Neo4j's vector storage round-trips through float32, so an exact `toEqual` on a stored vector is flaky. */
function expectVectorClose(actual: unknown, expected: readonly number[]): void {
  expect(Array.isArray(actual)).toBe(true);
  const values = actual as number[];
  expect(values).toHaveLength(expected.length);
  values.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index]!, 5);
  });
}

describe('vector_backfill: context vector pass', () => {
  const NEIGHBOR_VECTOR = Array.from(
    { length: EMBED_DIMENSION },
    (_, i) => (i + 1) / EMBED_DIMENSION,
  );
  const OTHER_VECTOR = Array.from(
    { length: EMBED_DIMENSION },
    (_, i) => (EMBED_DIMENSION - i) / EMBED_DIMENSION,
  );

  it("computes a stale node's context from its current neighbors and stays put once synced", async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'context-a',
      // Hashed as well as vectored: an unhashed vector is a pending one, and the content pass
      // would re-embed these two out from under the neighborhood this test is measuring.
      properties: {
        text: 'a',
        content_vec: NEIGHBOR_VECTOR,
        content_vec_hash: vectorInputHash('a'),
      },
      now: NOW,
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'context-b',
      properties: { text: 'b', content_vec: OTHER_VECTOR, content_vec_hash: vectorInputHash('b') },
      now: NOW,
    });
    await upsertEdge(harness.driver, {
      type: 'SIMILAR',
      sourceId: 'context-a',
      targetId: 'context-b',
      strength: 0.8,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });

    const operation = vectorBackfillOperation();
    const first = await operation.run(ctxFor());
    expect(first.itemsAffected).toBeGreaterThan(0);

    const a = await nodeProperties(harness.driver, 'context-a');
    const b = await nodeProperties(harness.driver, 'context-b');
    // A single vectored neighbor's weighted mean is exactly its own vector, modulo the
    // float32 round trip through Neo4j's vector storage.
    expectVectorClose(a.context_vec, OTHER_VECTOR);
    expectVectorClose(b.context_vec, NEIGHBOR_VECTOR);
    expect(a.context_vec_synced_at).toBeTruthy();

    const second = await operation.run(ctxFor({ now: LATER }));
    expect(second.detail).toContain('0 of 0 stale context vectors refreshed');

    // Reinforcement/decay moving the edge is what makes a synced context stale again.
    await upsertEdge(harness.driver, {
      type: 'SIMILAR',
      sourceId: 'context-a',
      targetId: 'context-b',
      strength: 0.9,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 1,
      now: LATER,
    });
    const third = await operation.run(ctxFor({ now: LATER }));
    expect(third.itemsAffected).toBeGreaterThan(0);
  }, 60_000);
});

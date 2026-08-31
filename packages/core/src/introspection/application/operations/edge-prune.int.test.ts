import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { edgePruneOperation } from './edge-prune.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { fetchAdjacency } from '../../../infrastructure/graph/adjacency.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { edgePruneState } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Six pairs, one per case the eligibility predicate distinguishes: floor and age both met on
 * an association type (two of these, one `CO_OCCURS` and one `SIMILAR`), floor met but too
 * young, age met but above the floor, and floor and age both met on a protected type (`CAUSES`,
 * `CONTRADICTS`) that pruning must still leave alone.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-31T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - 20 * DAY_MS);
const RECENT = new Date(NOW.getTime() - 5 * DAY_MS);
const WEIGHT_FLOOR = DEFAULTS.hebbian.weightFloor;

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = DEFAULTS;

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedEntity(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: OLD,
    properties: { name: id, name_norm: id, type: 'concept' },
  });
}

async function seedPair(
  sourceId: string,
  targetId: string,
  type: 'CO_OCCURS' | 'SIMILAR' | 'CAUSES' | 'CONTRADICTS',
  strength: number,
  writtenAt: Date,
): Promise<void> {
  await seedEntity(sourceId);
  await seedEntity(targetId);
  await upsertEdge(harness.driver, {
    type,
    sourceId,
    targetId,
    strength,
    confidence: 0.8,
    signals: ['test'],
    provenance: ['test'],
    count: 0,
    now: writtenAt,
  });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-edge-prune-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  // Eligible: at the floor, unreinforced for 20 days, a prunable type.
  await seedPair('co-occurs-eligible-a', 'co-occurs-eligible-b', 'CO_OCCURS', WEIGHT_FLOOR, OLD);
  await seedPair('similar-eligible-a', 'similar-eligible-b', 'SIMILAR', WEIGHT_FLOOR, OLD);
  // Ineligible: at the floor, but only 5 days unreinforced.
  await seedPair('too-young-a', 'too-young-b', 'CO_OCCURS', WEIGHT_FLOOR, RECENT);
  // Ineligible: 20 days unreinforced, but well above the floor.
  await seedPair('above-floor-a', 'above-floor-b', 'CO_OCCURS', 0.5, OLD);
  // Ineligible: at the floor and 20 days unreinforced, but a protected typed-knowledge edge.
  await seedPair('causes-protected-a', 'causes-protected-b', 'CAUSES', WEIGHT_FLOOR, OLD);
  await seedPair(
    'contradicts-protected-a',
    'contradicts-protected-b',
    'CONTRADICTS',
    WEIGHT_FLOOR,
    OLD,
  );
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('edge_prune', () => {
  it('closes exactly the edges at the floor and unreinforced past the threshold, on a prunable type', async () => {
    const outcome = await edgePruneOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(2);
    expect(outcome.detail).toContain('closed 2');
    expect(outcome.detail).toContain('at-floor 3->1');
    expect(outcome.detail).toContain('above-floor 1->1');

    const closedCoOccurs = await edgePruneState(
      harness.driver,
      'co-occurs-eligible-a',
      'co-occurs-eligible-b',
      'CO_OCCURS',
    );
    expect(closedCoOccurs.validUntil).toBeInstanceOf(Date);
    expect(closedCoOccurs.strength).toBe(WEIGHT_FLOOR);

    const closedSimilar = await edgePruneState(
      harness.driver,
      'similar-eligible-a',
      'similar-eligible-b',
      'SIMILAR',
    );
    expect(closedSimilar.validUntil).toBeInstanceOf(Date);
  });

  it('leaves the too-young, above-floor, and protected-type edges untouched', async () => {
    expect(
      (await edgePruneState(harness.driver, 'too-young-a', 'too-young-b', 'CO_OCCURS')).validUntil,
    ).toBeUndefined();
    expect(
      (await edgePruneState(harness.driver, 'above-floor-a', 'above-floor-b', 'CO_OCCURS'))
        .validUntil,
    ).toBeUndefined();
    expect(
      (await edgePruneState(harness.driver, 'causes-protected-a', 'causes-protected-b', 'CAUSES'))
        .validUntil,
    ).toBeUndefined();
    expect(
      (
        await edgePruneState(
          harness.driver,
          'contradicts-protected-a',
          'contradicts-protected-b',
          'CONTRADICTS',
        )
      ).validUntil,
    ).toBeUndefined();
  });

  it('vanishes from adjacency reads once closed, while an untouched pair still traverses', async () => {
    const closedNeighbors = await fetchAdjacency(harness.driver, {
      frontier: ['co-occurs-eligible-a'],
      visited: [],
      mode: withCurrency(),
      minStrength: 0,
      topK: 10,
    });
    expect(closedNeighbors.map((n) => n.nodeId)).not.toContain('co-occurs-eligible-b');

    const openNeighbors = await fetchAdjacency(harness.driver, {
      frontier: ['causes-protected-a'],
      visited: [],
      mode: withCurrency(),
      minStrength: 0,
      topK: 10,
    });
    expect(openNeighbors.map((n) => n.nodeId)).toContain('causes-protected-b');
  });

  it('finds nothing left to close on a second run over the same substrate', async () => {
    const outcome = await edgePruneOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.itemsAffected).toBe(0);
  });

  it('reopens a closed edge on the next co-occurrence write and returns it from adjacency again', async () => {
    await seedPair('reopen-a', 'reopen-b', 'CO_OCCURS', WEIGHT_FLOOR, OLD);
    await edgePruneOperation().run(context());
    const closed = await edgePruneState(harness.driver, 'reopen-a', 'reopen-b', 'CO_OCCURS');
    expect(closed.validUntil).toBeInstanceOf(Date);

    await upsertEdge(harness.driver, {
      type: 'CO_OCCURS',
      sourceId: 'reopen-a',
      targetId: 'reopen-b',
      strength: 0.6,
      confidence: 0.8,
      signals: ['test'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });

    const reopened = await edgePruneState(harness.driver, 'reopen-a', 'reopen-b', 'CO_OCCURS');
    expect(reopened.validUntil).toBeUndefined();
    expect(reopened.strength).toBe(0.6);

    const neighbors = await fetchAdjacency(harness.driver, {
      frontier: ['reopen-a'],
      visited: [],
      mode: withCurrency(),
      minStrength: 0,
      topK: 10,
    });
    expect(neighbors.map((n) => n.nodeId)).toContain('reopen-b');
  });
});

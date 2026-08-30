import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runRead } from '../../../infrastructure/graph/connection.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { countOrphanNodes } from '../../../infrastructure/graph/introspection-health.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { findOrphanNodes } from '../../../infrastructure/graph/topology-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { orphanCleanupOperation, orphanCleanupRelevance } from './orphan-cleanup.js';

/**
 * Five orphans, one per case the operation distinguishes:
 *
 * - an episode whose session holds a second episode, so it has a sibling to reach
 * - a decision extracted from an episode that mentions an entity, so it has an entity to reach
 * - the insight that marks the first episode enriched, which reaches nothing and is too new
 * - an ancient insight with no edges at all: no candidate, and old enough to give up on
 * - a recent insight with no edges: the same case without the age
 *
 * Beside them sits an episode reflection has not processed. It has only its session link, so
 * the old count read it as fragmentation; it is waiting on enrichment rather than broken, and
 * neither the count nor the sweep may touch it.
 *
 * The mentioning episode and the mentioned entity are not orphans themselves. A mention is an
 * association, and a node that carries one is already attached to the layer activation
 * traverses, which is what the orphan count is about.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = DEFAULTS;

function context(now: Date = NOW): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    health: healthFixture(),
    now,
    signal: new AbortController().signal,
  };
}

async function seedSession(id: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Session',
    id,
    now,
    properties: { started_at: now.toISOString() },
  });
}

async function seedEpisode(id: string, sessionId: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now,
    properties: { text: `body of ${id}` },
  });
  await upsertEdge(harness.driver, {
    type: 'PARTICIPATES_IN',
    sourceId: id,
    targetId: sessionId,
    strength: 1,
    confidence: 1,
    signals: ['structural'],
    provenance: ['test'],
    count: 0,
    now,
  });
}

/**
 * What makes an episode enriched as far as the graph is concerned: one node extracted from it.
 * The marker carries no other edge, so it neither hands the episode a relink candidate nor
 * hides one.
 */
async function markEnriched(episodeId: string, markerId: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: markerId,
    now,
    properties: { text: `something learned from ${episodeId}` },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: markerId,
    targetId: episodeId,
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test'],
    count: 0,
    now,
  });
}

async function seedLooseInsight(id: string, now: Date): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id,
    now,
    properties: { text: `a thought with nothing attached to it: ${id}` },
  });
}

async function relationshipTypesBetween(left: string, right: string): Promise<string[]> {
  return runRead(
    harness.driver,
    'MATCH (a:AionNode { id: $left })-[r]-(b:AionNode { id: $right }) RETURN type(r) AS type',
    { left, right },
    (row) => row['type'] as string,
  );
}

async function orphanIds(): Promise<string[]> {
  return (await findOrphanNodes(harness.driver, 100)).map((orphan) => orphan.id);
}

async function forgottenAt(id: string): Promise<Date | undefined> {
  const rows = await runRead(
    harness.driver,
    'MATCH (n:AionNode { id: $id }) RETURN n.forgotten_at AS forgotten_at',
    { id },
    (row) => row['forgotten_at'],
  );
  const value = rows[0];
  return value instanceof Date ? value : undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-orphan-cleanup-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await seedSession('shared-session', NOW);
  await seedEpisode('episode-with-sibling', 'shared-session', NOW);
  await seedEpisode('episode-sibling', 'shared-session', NOW);
  await markEnriched('episode-sibling', 'insight-from-sibling', NOW);

  // The entity route: an episode that mentions an entity, and a decision extracted from that
  // same episode. The decision itself has only its provenance edge, so it is an orphan whose
  // container can hand it an association.
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: 'entity-postgres',
    now: NOW,
    properties: { name: 'Postgres', name_norm: 'postgres', type: 'tool' },
  });
  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: 'episode-with-sibling',
    targetId: 'entity-postgres',
    strength: 0.8,
    confidence: 0.8,
    signals: ['extraction'],
    provenance: ['test'],
    count: 3,
    now: NOW,
  });
  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id: 'decision-orphan',
    now: NOW,
    properties: { text: 'we picked Postgres' },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: 'decision-orphan',
    targetId: 'episode-with-sibling',
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });

  await seedLooseInsight('insight-ancient-alone', LONG_AGO);
  await seedLooseInsight('insight-recent-alone', NOW);

  // Stored months ago and never enriched. Nothing was extracted from it, so it has only its
  // session link, and it belongs to the enrichment backlog rather than to this sweep.
  await seedSession('lonely-old-session', LONG_AGO);
  await seedEpisode('episode-unenriched-alone', 'lonely-old-session', LONG_AGO);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('orphan cleanup', () => {
  it('stays at zero relevance until the snapshot actually meets the orphan condition', () => {
    const quiet = healthFixture({
      graph: { ...healthFixture().graph, nodes: 100, orphanNodes: 5, orphanShare: 0.05 },
    });
    expect(orphanCleanupRelevance(quiet)).toBe(0);

    const fragmented = healthFixture({
      graph: { ...healthFixture().graph, nodes: 100, orphanNodes: 40, orphanShare: 0.4 },
    });
    expect(orphanCleanupRelevance(fragmented)).toBeCloseTo(0.4);
  });

  it('leaves an episode waiting on enrichment out of the count and out of the sweep', async () => {
    const before = await countOrphanNodes(harness.driver);
    expect(before.orphans).toBe(5);
    expect(await orphanIds()).not.toContain('episode-unenriched-alone');
  });

  it('relinks what it can reach and forgets only what has waited long enough', async () => {
    const outcome = await orphanCleanupOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(5);
    // Two relinked, one forgotten, two left alone because they are too new to give up on.
    expect(outcome.itemsAffected).toBe(3);

    expect(await relationshipTypesBetween('decision-orphan', 'entity-postgres')).toContain(
      'RELATED_TO',
    );
    expect(await relationshipTypesBetween('episode-with-sibling', 'episode-sibling')).toContain(
      'RELATED_TO',
    );
    expect(await forgottenAt('insight-ancient-alone')).toBeInstanceOf(Date);
    expect(await forgottenAt('insight-recent-alone')).toBeUndefined();
    // The unenriched episode is older than the forget threshold and was still not touched.
    expect(await forgottenAt('episode-unenriched-alone')).toBeUndefined();

    const after = await countOrphanNodes(harness.driver);
    expect(after.orphans).toBeLessThan(5);
  });

  it('finds nothing left to repair on a second run over the same substrate', async () => {
    const outcome = await orphanCleanupOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
  });
});

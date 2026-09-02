import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeHealth } from './observe.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import {
  countEpisodesWithoutSession,
  countOrphanNodes,
  countVectorParity,
} from '../../infrastructure/graph/introspection-health.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { findPendingVectorNodes } from '../../infrastructure/graph/pending-vectors.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { squashName } from '../../reflection/domain/entity-reconciliation.js';

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
// Vector parity counts a node as vectored only with the hash the floats were taken over.
const VECTOR_HASH = 'a'.repeat(64);

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = DEFAULTS;

/**
 * One substrate for the whole file, seeded once. The harness lease clears the graph per file
 * rather than per test, and every assertion below is a count over that one seeded shape, so a
 * shared substrate is what keeps the expected numbers stable and readable.
 *
 * The shape: two episodes in a session and one loose one, one entity each side of the vector
 * line, and one entity attached to nothing but the backbone. One of the episodes in the
 * session carries an extracted insight, which is what makes it enriched: an episode nothing has
 * been extracted from is waiting on reflection and is left out of the orphan population, so
 * without that insight there would be no orphan episode here to count.
 */
beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-observe-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'session-1',
    properties: { started_at: NOW.toISOString() },
    now: NOW,
  });
  for (const id of ['episode-in-session', 'episode-also-in-session']) {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id,
      properties: { text: `body of ${id}`, content_vec: VECTOR, content_vec_hash: VECTOR_HASH },
      now: NOW,
    });
    await upsertEdge(harness.driver, {
      type: 'PARTICIPATES_IN',
      sourceId: id,
      targetId: 'session-1',
      strength: 1,
      confidence: 1,
      signals: ['structural'],
      provenance: ['test'],
      count: 1,
      now: NOW,
    });
  }
  await writeStampedNode(harness.driver, {
    label: 'Insight',
    id: 'insight-from-episode',
    properties: {
      text: 'what the first episode came to',
      content_vec: VECTOR,
      content_vec_hash: VECTOR_HASH,
    },
    now: NOW,
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: 'insight-from-episode',
    targetId: 'episode-in-session',
    strength: 1,
    confidence: 1,
    signals: ['provenance'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: 'episode-loose',
    properties: {
      text: 'body of the loose episode',
      content_vec: VECTOR,
      content_vec_hash: VECTOR_HASH,
    },
    now: NOW,
  });
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: 'entity-unvectorized',
    properties: {
      name: 'unvectorized',
      name_norm: 'unvectorized',
      type: 'concept',
      text: 'waiting on an embed',
    },
    now: NOW,
  });
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: 'entity-associated',
    properties: {
      name: 'associated',
      name_norm: 'associated',
      type: 'concept',
      text: 'linked',
      content_vec: VECTOR,
      content_vec_hash: VECTOR_HASH,
    },
    now: NOW,
  });
  await upsertEdge(harness.driver, {
    type: 'CO_OCCURS',
    sourceId: 'entity-associated',
    targetId: 'entity-unvectorized',
    strength: 0.5,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('graph health counts', () => {
  it('counts the nodes that should carry a vector against the ones that do', async () => {
    const parity = await countVectorParity(harness.driver);
    expect(parity).toEqual({ expected: 6, vectored: 5 });
  });

  it('counts a vector with no hash as missing, the same population the drain reads', async () => {
    // A re-enqueue clears the hash and leaves the floats: the node is behind, because nothing
    // can show the stored vector was taken over the text the node holds now.
    await harness.driver.executeQuery(
      'MATCH (n:Episode { id: $id }) SET n.content_vec_hash = null',
      { id: 'episode-loose' },
    );
    try {
      expect(await countVectorParity(harness.driver)).toEqual({ expected: 6, vectored: 4 });
      expect(await findPendingVectorNodes(harness.driver, 10)).toContainEqual(
        expect.objectContaining({ id: 'episode-loose' }),
      );
    } finally {
      await harness.driver.executeQuery(
        'MATCH (n:Episode { id: $id }) SET n.content_vec_hash = $hash',
        { id: 'episode-loose', hash: VECTOR_HASH },
      );
    }
  });

  it('counts a node whose every edge is backbone or provenance as an orphan', async () => {
    const orphans = await countOrphanNodes(harness.driver);
    // Four of the six memory nodes are in scope: the two episodes nothing was extracted from
    // are waiting on reflection rather than fragmented, and neither one is counted.
    expect(orphans.nodes).toBe(4);
    // The two associated entities are connected; the enriched episode and its own insight
    // reach nothing but the backbone.
    expect(orphans.orphans).toBe(2);
  });

  it('counts an episode with no session as a missing backbone link', async () => {
    expect(await countEpisodesWithoutSession(harness.driver)).toBe(1);
  });
});

describe('observeHealth', () => {
  it('assembles one snapshot from every collector', async () => {
    // The entities collector needs its own squash-equal pair: nothing else seeded above holds
    // a name_squash collision. Both land in scope for the orphan count too (no text, so vector
    // parity is untouched, and no edges, so each is its own orphan).
    for (const [id, name] of [
      ['entity-squash-a', 're-mark'],
      ['entity-squash-b', 'remark'],
    ] as const) {
      const nameNorm = name.toLowerCase();
      await writeStampedNode(harness.driver, {
        label: 'Entity',
        id,
        properties: {
          name,
          name_norm: nameNorm,
          name_squash: squashName(nameNorm),
          type: 'concept',
        },
        now: NOW,
      });
    }

    // The identifier collector needs a machine-minted name; nothing else seeded here has one.
    // No text, so vector parity is untouched, and no edges, so it is its own orphan.
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id: 'entity-sha',
      properties: {
        name: '0f7c1b2d3e4f50617283940a1b2c3d4e5f607182',
        name_norm: '0f7c1b2d3e4f50617283940a1b2c3d4e5f607182',
        name_squash: squashName('0f7c1b2d3e4f50617283940a1b2c3d4e5f607182'),
        type: 'artifact',
      },
      now: NOW,
    });

    const snapshot = await observeHealth(
      { driver: harness.driver, db, config, logger },
      { operations: [{ name: 'fake_operation', measured: true }], cycle: 7, now: NOW },
    );

    expect(snapshot.degraded).toEqual([]);
    expect(snapshot.cycle).toBe(7);
    expect(snapshot.observedAt).toBe(NOW.toISOString());
    expect(snapshot.graph.vectorParity).toBeCloseTo(5 / 6, 6);
    expect(snapshot.graph.episodesWithoutSession).toBe(1);
    // The two squash-equal entities and the digest-named one join the orphan population too:
    // none of the three carries an edge.
    expect(snapshot.graph.orphanShare).toBeCloseTo(5 / 7, 6);
    expect(snapshot.entities.tier0Eligible).toBe(2);
    // The digest name is the only one of the nine entities and episodes shaped like an
    // identifier; every other name here is a word.
    expect(snapshot.entities.identifierShaped).toBe(1);
    // The one CO_OCCURS edge; the two PARTICIPATES_IN and the one EXTRACTED_FROM are protected.
    expect(snapshot.graph.decayableEdges).toBe(1);
    // That same CO_OCCURS edge sits at 0.5, well above the 0.1 weight floor, so nothing here
    // is prunable and the narrower count reads zero while the coarser one reads one.
    expect(snapshot.graph.atFloorAssociationEdges).toBe(0);
    expect(snapshot.enrichment.unenriched).toBe(3);
    expect(snapshot.queue.depth).toBe(0);
    expect(snapshot.proposals.oldestOpenAgeMs).toBeUndefined();
    expect(snapshot.effectiveness).toEqual([
      {
        name: 'fake_operation',
        runs: 0,
        improved: 0,
        failed: 0,
        // Declaring a metric is not the same as having been scored on one.
        effectiveness: undefined,
        cyclesSinceSelected: 7,
        lastRunAt: undefined,
        meanDurationMs: undefined,
      },
    ]);
  });

  it('names the collector that failed and keeps the rest of the reading', async () => {
    // Every collector reaches the driver through `executeQuery` alone, so a fake exposing
    // only that method exercises the same failure path a spread of the real instance would
    // (a spread would copy no prototype method anyway, `executeQuery` included).
    const broken = { executeQuery: () => Promise.reject(new Error('bolt closed')) };
    const snapshot = await observeHealth(
      { driver: broken as unknown as Neo4jHarness['driver'], db, config, logger },
      { now: NOW },
    );

    expect(snapshot.degraded).toContain('graph');
    expect(snapshot.graph.vectorParity).toBe(1);
    expect(snapshot.graph.decayableEdges).toBe(0);
    expect(snapshot.queue.depth).toBe(0);
    expect(snapshot.plasticity.reinforcementQueueDepth).toBe(0);
    expect(snapshot.degraded).toContain('entities');
    expect(snapshot.entities.tier0Eligible).toBe(0);
    expect(snapshot.entities.identifierShaped).toBe(0);
    expect(snapshot.graph.atFloorAssociationEdges).toBe(0);
  });
});

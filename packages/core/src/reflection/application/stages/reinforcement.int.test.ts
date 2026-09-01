import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReinforcementEnqueueStage } from './reinforcement.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { supersede, writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { CONTAINMENT_TYPE } from '../../../infrastructure/graph/episodes.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { findCoExtractedNodeIds } from '../../../infrastructure/graph/reinforcement-queries.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listReinforcementSignals } from '../../../infrastructure/sqlite/reinforcement-queue.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * The trigger is entities and cognitive structures extracted from one episode. The episode
 * this file builds also carries the three turns intake writes, which link to it with the same
 * containment type the entity stage uses, so a read that follows containment pairs every turn
 * with every other and the queue stops being about extracted structure at all.
 */

const NOW = new Date('2026-08-28T12:00:00.000Z');
const EPISODE_ID = 'reinforcement-int-episode';
const SESSION_ID = 'reinforcement-int-session';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let entityId: string;
let mergedAwayEntityId: string;
const decisionId = 'reinforcement-int-decision';
const turnIds = ['turn-1', 'turn-2', 'turn-3'];

function context(): StageContext {
  return {
    driver: harness.driver,
    db,
    provider: { embed: async () => [], generate: async () => ({}) },
    episodeId: EPISODE_ID,
    episode: { id: EPISODE_ID, sessionId: SESSION_ID, text: '', turns: [] },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-reinforcement-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });

  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: EPISODE_ID,
    now: NOW,
    properties: { text: 'a working session', session_id: SESSION_ID },
  });

  for (const [index, turnId] of turnIds.entries()) {
    await writeStampedNode(harness.driver, {
      label: 'Turn',
      id: turnId,
      now: NOW,
      properties: { text: `turn ${String(index)}`, source_episode_id: EPISODE_ID },
    });
    await upsertEdge(harness.driver, {
      type: CONTAINMENT_TYPE,
      sourceId: turnId,
      targetId: EPISODE_ID,
      strength: 1,
      confidence: 1,
      signals: ['structural'],
      provenance: ['test'],
      count: 0,
      now: NOW,
    });
  }

  const merged = await mergeEntities(
    harness.driver,
    [
      {
        name: 'Neo4j',
        nameNorm: 'neo4j',
        type: 'tool',
        text: 'Neo4j (tool): the graph store',
        sourceEpisodeId: EPISODE_ID,
        extractionMethod: 'test',
        confidence: 0.8,
      },
      {
        name: 'Neo4J',
        nameNorm: 'neo4j server',
        type: 'tool',
        text: 'Neo4J (tool): a duplicate a later run merged away',
        sourceEpisodeId: EPISODE_ID,
        extractionMethod: 'test',
        confidence: 0.8,
      },
    ],
    NOW,
  );
  entityId = merged[0]?.id ?? '';
  mergedAwayEntityId = merged[1]?.id ?? '';
  await linkEntityMentions(harness.driver, {
    episodeId: EPISODE_ID,
    entityIds: [entityId, mergedAwayEntityId],
    now: NOW,
    confidence: 0.8,
    provenance: ['test'],
  });

  await writeStampedNode(harness.driver, {
    label: 'Decision',
    id: decisionId,
    now: NOW,
    properties: { text: 'keep Neo4j', source_episode_id: EPISODE_ID },
  });
  await upsertEdge(harness.driver, {
    type: 'EXTRACTED_FROM',
    sourceId: decisionId,
    targetId: EPISODE_ID,
    strength: 1,
    confidence: 1,
    signals: ['extraction'],
    provenance: ['test'],
    count: 0,
    now: NOW,
  });

  // The state a merge leaves behind: still mentioned by the episode, no longer the identity.
  await supersede(harness.driver, { oldId: mergedAwayEntityId, newId: entityId, now: NOW });
}, 180_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reflection co-extraction against a live graph', () => {
  it('reads only the current entities and cognitive nodes the episode produced', async () => {
    const ids = await findCoExtractedNodeIds(harness.driver, EPISODE_ID);

    expect([...ids].sort()).toEqual([decisionId, entityId].sort());
    for (const turnId of turnIds) {
      expect(ids).not.toContain(turnId);
    }
    expect(ids).not.toContain(mergedAwayEntityId);
    expect(ids).not.toContain(EPISODE_ID);
  }, 60_000);

  it('enqueues exactly the one genuine pair', async () => {
    const outcome = await new ReinforcementEnqueueStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ reinforcements: 1 });

    const signals = listReinforcementSignals(db);
    expect(signals).toHaveLength(1);
    expect([signals[0]?.sourceId, signals[0]?.targetId].sort()).toEqual(
      [decisionId, entityId].sort(),
    );
  }, 60_000);

  it('does not re-enqueue the pair when the stage runs again for the same episode', async () => {
    await new ReinforcementEnqueueStage().run(context());

    expect(listReinforcementSignals(db)).toHaveLength(1);
  }, 60_000);
});

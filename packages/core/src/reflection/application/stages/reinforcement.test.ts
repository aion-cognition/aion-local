import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ReinforcementEnqueueStage, REFLECTION_CO_EXTRACTION_TRIGGER } from './reinforcement.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { listReinforcementSignals } from '../../../infrastructure/sqlite/reinforcement-queue.js';
import type { StageContext } from '../../domain/stage.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';

describe('ReinforcementEnqueueStage', () => {
  let driver: Driver;
  let store: SqliteStore;
  let graph: FakeGraph;
  let dataDir: string;

  beforeEach(async () => {
    graph = new FakeGraph();
    ({ driver } = graph);
    dataDir = mkdtempSync(join(tmpdir(), 'aion-reinforcement-test-'));
    store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  });

  afterEach(async () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('skips when the episode has no extracted nodes', async () => {
    const episodeId = 'episode-1';
    graph.seedNode(episodeId, ['Episode', 'AionNode']);

    const stage = new ReinforcementEnqueueStage();
    const ctx: StageContext = {
      driver,
      db: store.db,
      provider: {} as any,
      episodeId,
      episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
      logger: openLogger({ filePath: join(dataDir, 'test.jsonl'), level: 'fatal' }),
      now: new Date(),
    };

    const result = await stage.run(ctx);

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('no entities');
    expect(listReinforcementSignals(store.db)).toHaveLength(0);
  });

  it('returns ok with no pairs when only one node is extracted', async () => {
    const episodeId = 'episode-1';
    const nodeId = 'node-1';

    graph.seedNode(episodeId, ['Episode', 'AionNode']);
    graph.seedNode(nodeId, ['Entity', 'AionNode'], { type: 'person' });
    graph.seedEdge('MENTIONS', episodeId, nodeId);

    const stage = new ReinforcementEnqueueStage();
    const ctx: StageContext = {
      driver,
      db: store.db,
      provider: {} as any,
      episodeId,
      episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
      logger: openLogger({ filePath: join(dataDir, 'test.jsonl'), level: 'fatal' }),
      now: new Date(),
    };

    const result = await stage.run(ctx);

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('one node');
    expect(listReinforcementSignals(store.db)).toHaveLength(0);
  });

  it('enqueues one signal per pair for 3 extracted nodes (3 pairs total)', async () => {
    const episodeId = 'episode-1';
    const nodeIds = ['node-1', 'node-2', 'node-3'];

    graph.seedNode(episodeId, ['Episode', 'AionNode']);
    for (const nodeId of nodeIds) {
      graph.seedNode(nodeId, ['Entity', 'AionNode'], { type: 'person' });
      graph.seedEdge('MENTIONS', episodeId, nodeId);
    }

    const stage = new ReinforcementEnqueueStage();
    const ctx: StageContext = {
      driver,
      db: store.db,
      provider: {} as any,
      episodeId,
      episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
      logger: openLogger({ filePath: join(dataDir, 'test.jsonl'), level: 'fatal' }),
      now: new Date('2025-01-15T10:00:00Z'),
    };

    const result = await stage.run(ctx);

    expect(result.status).toBe('ok');
    expect(result.counts?.reinforcements).toBe(3);

    const signals = listReinforcementSignals(store.db);
    expect(signals).toHaveLength(3);

    for (const signal of signals) {
      expect(signal.trigger).toBe(REFLECTION_CO_EXTRACTION_TRIGGER);
    }

    // Deterministic pair order: sorted node ids, never (b,a) when (a,b) exists.
    const [first, second, third] = [...nodeIds].sort();
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected exactly three sorted node ids');
    }
    const expectedPairs: [string, string][] = [
      [first, second],
      [first, third],
      [second, third],
    ];

    const actualPairs = signals.map((s) => [s.sourceId, s.targetId] as [string, string]);
    expect(actualPairs).toEqual(expectedPairs);
  });

  it('re-running the same episode enqueues nothing further', async () => {
    const episodeId = 'episode-1';
    const nodeIds = ['node-1', 'node-2'];

    graph.seedNode(episodeId, ['Episode', 'AionNode']);
    for (const nodeId of nodeIds) {
      graph.seedNode(nodeId, ['Entity', 'AionNode'], { type: 'person' });
      graph.seedEdge('MENTIONS', episodeId, nodeId);
    }

    const stage = new ReinforcementEnqueueStage();
    const ctx: StageContext = {
      driver,
      db: store.db,
      provider: {} as any,
      episodeId,
      episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
      logger: openLogger({ filePath: join(dataDir, 'test.jsonl'), level: 'fatal' }),
      now: new Date('2025-01-15T10:00:00Z'),
    };

    await stage.run(ctx);
    expect(listReinforcementSignals(store.db)).toHaveLength(1);

    // The orchestrator's crash-before-ledger-mark window: the stage runs a second time for
    // the same episode and must not double what the flush will apply.
    const second = await stage.run(ctx);
    expect(second.status).toBe('skipped');
    expect(listReinforcementSignals(store.db)).toHaveLength(1);
  });

  it('handles mixed entity and cognitive nodes', async () => {
    const episodeId = 'episode-1';
    const entityId = 'entity-1';
    const cognitiveId = 'cognitive-1';

    graph.seedNode(episodeId, ['Episode', 'AionNode']);
    graph.seedNode(entityId, ['Entity', 'AionNode'], { type: 'person' });
    graph.seedEdge('MENTIONS', episodeId, entityId);
    graph.seedNode(cognitiveId, ['Goal', 'AionNode']);
    graph.seedEdge('EXTRACTED_FROM', cognitiveId, episodeId);

    const stage = new ReinforcementEnqueueStage();
    const ctx: StageContext = {
      driver,
      db: store.db,
      provider: {} as any,
      episodeId,
      episode: { id: episodeId, sessionId: 'session-1', text: '', turns: [] },
      logger: openLogger({ filePath: join(dataDir, 'test.jsonl'), level: 'fatal' }),
      now: new Date(),
    };

    const result = await stage.run(ctx);

    expect(result.status).toBe('ok');
    expect(result.counts?.reinforcements).toBe(1);

    const signals = listReinforcementSignals(store.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.trigger).toBe(REFLECTION_CO_EXTRACTION_TRIGGER);
  });
});

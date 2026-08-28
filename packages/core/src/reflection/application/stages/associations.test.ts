import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';
import { AssociationInferenceStage } from './associations.js';

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');

const NOOP_PROVIDER: Provider = {
  embed: async () => {
    throw new Error('association inference must never call embed');
  },
  generate: async () => {
    throw new Error('association inference must never call generate');
  },
};

function entity(id: string, name: string): void {
  graph.seedNode(id, ['Entity', 'Memory', 'AionNode'], {
    name,
    name_norm: name.toLowerCase(),
    type: 'concept',
  });
}

function mention(entityId: string, episodeId = EPISODE_ID): void {
  graph.seedEdge('MENTIONS', episodeId, entityId);
}

let graph: FakeGraph;
let dataDir: string;
let db: SqliteHandle;
let logger: Logger;

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode']);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-associations-stage-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function buildContext(episodeId = EPISODE_ID): StageContext {
  return {
    driver: graph.driver,
    db,
    provider: NOOP_PROVIDER,
    episodeId,
    episode: { id: episodeId, sessionId: 'session-1', text: 'irrelevant to this stage', turns: [] },
    logger,
    now: NOW,
  };
}

describe('AssociationInferenceStage', () => {
  it('skips an episode that mentions no entities', async () => {
    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome).toEqual({ status: 'skipped', summary: 'no entities mentioned in the episode' });
    expect(graph.edgesOfType('CO_OCCURS')).toHaveLength(0);
  });

  it('reports ok with no work for a single mentioned entity: nothing to pair, no vector to compare', async () => {
    entity('e1', 'Alice');
    mention('e1');

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome).toEqual({
      status: 'ok',
      summary: '0 co-occurrence edge(s), 0 semantic edge(s)',
      counts: { associations: 0 },
    });
  });

  it('links every pair of co-occurring entities with count 1', async () => {
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    entity('e3', 'Carol');
    mention('e1');
    mention('e2');
    mention('e3');

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome).toEqual({
      status: 'ok',
      summary: '3 co-occurrence edge(s), 0 semantic edge(s)',
      counts: { associations: 3 },
    });
    const edges = graph.edgesOfType('CO_OCCURS');
    expect(edges).toHaveLength(3);
    for (const edge of edges) {
      expect(edge.count).toBe(1);
      expect(edge.provenance).toEqual(['reflection']);
    }
  });

  it('re-running the same episode is a no-op: the ledger gate leaves counts untouched', async () => {
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    mention('e1');
    mention('e2');
    const stage = new AssociationInferenceStage();
    const ctx = buildContext();

    const first = await stage.run(ctx);
    const second = await stage.run(ctx);

    expect(first.counts).toEqual({ associations: 1 });
    expect(second).toEqual({
      status: 'ok',
      summary: '0 co-occurrence edge(s), 0 semantic edge(s)',
      counts: { associations: 0 },
    });
    const [edge] = graph.edgesOfType('CO_OCCURS');
    expect(edge?.count).toBe(1);
  });

  it('a second episode sharing the pair bumps the count instead of being gated', async () => {
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    mention('e1', EPISODE_ID);
    mention('e2', EPISODE_ID);
    graph.seedNode('episode-2', ['Episode', 'Memory', 'AionNode']);
    mention('e1', 'episode-2');
    mention('e2', 'episode-2');
    const stage = new AssociationInferenceStage();

    await stage.run(buildContext(EPISODE_ID));
    const second = await stage.run(buildContext('episode-2'));

    expect(second.counts).toEqual({ associations: 1 });
    const [edge] = graph.edgesOfType('CO_OCCURS');
    expect(edge?.count).toBe(2);
  });

  it('produces the same pair set regardless of the order entities come back in', async () => {
    entity('e3', 'Carol');
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    // Seeded out of name_norm order; FakeGraph's #episodeEntities sorts before returning,
    // matching the live query's ORDER BY, so pairing is exercised against sorted input either way.
    mention('e3');
    mention('e1');
    mention('e2');

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome.counts).toEqual({ associations: 3 });
    expect(graph.edgesOfType('CO_OCCURS')).toHaveLength(3);
  });

  it('skips semantic similarity without erroring when no mentioned entity has a content vector yet', async () => {
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    mention('e1');
    mention('e2');

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome.status).toBe('ok');
    expect(graph.edgesOfType('SIMILAR')).toHaveLength(0);
  });

  it('reports a failed stage with partial counts when a graph write fails mid-run', async () => {
    entity('e1', 'Alice');
    entity('e2', 'Bob');
    entity('e3', 'Carol');
    mention('e1');
    mention('e2');
    mention('e3');
    const original = graph.executeQuery.bind(graph);
    let writes = 0;
    graph.executeQuery = async (cypher: string, parameters: Record<string, unknown> = {}) => {
      if (/MERGE \(a\)-\[r:CO_OCCURS\]->\(b\)/.exec(cypher) !== null) {
        writes += 1;
        if (writes === 2) {
          throw new Error('graph unreachable');
        }
      }
      return original(cypher, parameters);
    };

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('after writing 1 of 3 pair(s)');
    expect(outcome.counts).toEqual({ associations: 1 });
  });

  it('fails when the episode-entity read itself throws', async () => {
    graph.executeQuery = async () => {
      throw new Error('neo4j unreachable');
    };

    const outcome = await new AssociationInferenceStage().run(buildContext());

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('neo4j unreachable');
  });
});

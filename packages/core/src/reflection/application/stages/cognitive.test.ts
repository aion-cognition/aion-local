import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  deriveCognitiveNodeId,
  TEXT_NORM_PROPERTY,
} from '../../../infrastructure/graph/cognitive-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { fromGraphDateTime } from '../../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest, Vector } from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';
import { CognitiveExtractionStage } from './cognitive.js';

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const OCCURRED_AT = new Date('2026-08-28T09:00:00.000Z');

type GenerateFn = (req: StructuredRequest) => Promise<unknown>;
type EmbedFn = (texts: readonly string[]) => Promise<Vector[]>;

function stubProvider(generate: GenerateFn, embed?: EmbedFn): Provider {
  return {
    generate,
    embed: embed ?? (async (texts) => texts.map((_, i) => [i, 0.5, 0.25])),
  };
}

let graph: FakeGraph;
let dataDir: string;
let logger: Logger;

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode']);
  dataDir = mkdtempSync(join(tmpdir(), 'aion-cognitive-stage-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function buildContext(provider: Provider, text = 'user: ship it\nassistant: shipping now'): StageContext {
  return {
    driver: graph.driver,
    db: undefined as unknown as SqliteHandle,
    provider,
    episodeId: EPISODE_ID,
    episode: {
      id: EPISODE_ID,
      sessionId: 'session-1',
      text,
      occurredAt: OCCURRED_AT,
      turns: [],
    },
    logger,
    now: NOW,
  };
}

describe('CognitiveExtractionStage', () => {
  it('skips an episode with no text', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(buildContext(stubProvider(async () => ({ nodes: [] })), '   '));

    expect(outcome).toEqual({ status: 'skipped', summary: 'episode has no text to extract from' });
    expect(graph.nodesWithLabel('Goal')).toHaveLength(0);
  });

  it('skips when the model finds no cognitive structure', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(buildContext(stubProvider(async () => ({ nodes: [] }))));

    expect(outcome).toEqual({ status: 'skipped', summary: 'no cognitive structure found in the episode' });
  });

  it('extracts, embeds, and links each node type with its modest per-type fields', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [
        { type: 'Goal', text: 'ship the worker', status: 'active', priority: 'high' },
        { type: 'Decision', text: 'use SQLite for the queue', rationale: 'no Redis dependency' },
        { type: 'Insight', text: 'idempotency needs two levels' },
      ],
    });
    const embedded: string[][] = [];
    const embed: EmbedFn = async (texts) => {
      embedded.push([...texts]);
      return texts.map((_, i) => [i + 1, 0.1, 0.2]);
    };
    const stage = new CognitiveExtractionStage();

    const outcome = await stage.run(buildContext(stubProvider(generate, embed)));

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toBe('extracted 3 cognitive node(s), 3 new');
    expect(outcome.counts).toEqual({ cognitive: 3 });
    expect(embedded).toEqual([['ship the worker', 'use SQLite for the queue', 'idempotency needs two levels']]);

    const goal = graph.nodesWithLabel('Goal')[0];
    expect(goal?.labels).toEqual(expect.arrayContaining(['Goal', 'Memory', 'AionNode']));
    expect(goal?.properties[MEMORY_PROPERTIES.text]).toBe('ship the worker');
    expect(goal?.properties.status).toBe('active');
    expect(goal?.properties.priority).toBe('high');
    expect(goal?.properties[MEMORY_PROPERTIES.contentVector]).toEqual([1, 0.1, 0.2]);
    expect(fromGraphDateTime(goal?.properties[BITEMPORAL_PROPERTIES.occurredAt])).toEqual(OCCURRED_AT);

    const decision = graph.nodesWithLabel('Decision')[0];
    expect(decision?.properties[MEMORY_PROPERTIES.text]).toBe('use SQLite for the queue');
    expect(decision?.properties.rationale).toBe('no Redis dependency');
    expect(decision?.properties.status).toBeUndefined();

    const insight = graph.nodesWithLabel('Insight')[0];
    expect(insight?.properties.status).toBeUndefined();
    expect(insight?.properties.rationale).toBeUndefined();
    expect(insight?.properties.priority).toBeUndefined();

    const extractedFrom = graph.edgesOfType('EXTRACTED_FROM');
    expect(extractedFrom).toHaveLength(3);
    for (const edge of extractedFrom) {
      expect(edge.targetId).toBe(EPISODE_ID);
      expect(edge.count).toBe(0);
    }
    expect(extractedFrom.map((edge) => edge.sourceId).sort()).toEqual(
      [goal?.id, decision?.id, insight?.id].sort(),
    );
  });

  it('derives node identity from (episode, type, normalized text), documented and stable', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [{ type: 'Insight', text: '  Idempotency   needs two levels  ' }],
    });
    const stage = new CognitiveExtractionStage();

    await stage.run(buildContext(stubProvider(generate)));

    const [insight] = graph.nodesWithLabel('Insight');
    expect(insight?.id).toBe(
      deriveCognitiveNodeId(EPISODE_ID, 'Insight', 'idempotency needs two levels'),
    );
    expect(insight?.properties[TEXT_NORM_PROPERTY]).toBe('idempotency needs two levels');
  });

  it('re-running on the same episode with the same output is a no-op: no duplicate nodes or edges', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [{ type: 'Insight', text: 'idempotency needs two levels' }],
    });
    const stage = new CognitiveExtractionStage();
    const ctx = buildContext(stubProvider(generate));

    const first = await stage.run(ctx);
    const second = await stage.run(ctx);

    expect(first.summary).toBe('extracted 1 cognitive node(s), 1 new');
    expect(second.summary).toBe('extracted 1 cognitive node(s), 0 new');
    expect(graph.nodesWithLabel('Insight')).toHaveLength(1);
    expect(graph.edgesOfType('EXTRACTED_FROM')).toHaveLength(1);
    expect(graph.edgesOfType('EXTRACTED_FROM')[0]?.count).toBe(0);
  });

  it('caps extraction at maxNodes', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [
        { type: 'Concept', text: 'one' },
        { type: 'Concept', text: 'two' },
        { type: 'Concept', text: 'three' },
      ],
    });
    const stage = new CognitiveExtractionStage({ maxNodes: 2 });

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ cognitive: 2 });
    expect(graph.nodesWithLabel('Concept')).toHaveLength(2);
  });

  it('fails on a response that does not match the extraction schema', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(stubProvider(async () => ({ nodes: [{ type: 'NotAType', text: 'x' }] }))),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('invalid shape');
  });

  it('fails when the model call throws, without throwing itself', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(
        stubProvider(async () => {
          throw new Error('ollama unreachable');
        }),
      ),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('ollama unreachable');
  });

  it('writes nodes without a content vector when embedding fails, rather than failing the stage', async () => {
    const generate = async (): Promise<unknown> => ({ nodes: [{ type: 'Concept', text: 'graceful degradation' }] });
    const embed: EmbedFn = async () => {
      throw new Error('embed model unavailable');
    };
    const stage = new CognitiveExtractionStage();

    const outcome = await stage.run(buildContext(stubProvider(generate, embed)));

    expect(outcome.status).toBe('ok');
    const [node] = graph.nodesWithLabel('Concept');
    expect(node?.properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
  });

  it('reports a failed stage with partial counts when a graph write fails mid-run', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [
        { type: 'Concept', text: 'first' },
        { type: 'Concept', text: 'second' },
      ],
    });
    const stage = new CognitiveExtractionStage();
    const original = graph.executeQuery.bind(graph);
    let calls = 0;
    graph.executeQuery = async (cypher: string, parameters: Record<string, unknown> = {}) => {
      calls += 1;
      // The first node's write is one transaction (node merge + edge merge); the second
      // node's write fails on its first statement.
      if (calls === 3) {
        throw new Error('graph unreachable');
      }
      return original(cypher, parameters);
    };

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('wrote 1 of 2');
    expect(outcome.counts).toEqual({ cognitive: 1 });
    expect(graph.nodesWithLabel('Concept')).toHaveLength(1);
  });
});

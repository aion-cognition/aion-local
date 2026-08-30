import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SemanticRelationshipFakeGraph } from './semantic-relationships.fixture.js';
import { SemanticRelationshipStage } from './semantic-relationships.js';
import { ENTITY_MENTION_TYPE } from '../../../infrastructure/graph/entity-queries.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type {
  Provider,
  StructuredRequest,
  Vector,
} from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const DEFAULT_TEXT = 'user: ship it\nassistant: shipping now';
/** A verbatim span of DEFAULT_TEXT, so a proposal referencing it clears the quote check. */
const VALID_QUOTE = 'ship it';

type GenerateFn = (req: StructuredRequest) => Promise<unknown>;

function stubProvider(generate: GenerateFn): Provider {
  return {
    generate,
    embed: async (texts: readonly string[]): Promise<Vector[]> =>
      texts.map((_, i) => [i, 0.5, 0.25]),
  };
}

let graph: SemanticRelationshipFakeGraph;
let dataDir: string;
let logger: Logger;

beforeEach(() => {
  graph = new SemanticRelationshipFakeGraph();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-semantic-relationships-stage-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedEntity(id: string, name: string, type: string): void {
  graph.seedNode(id, ['Entity', 'Memory', 'AionNode'], {
    name,
    name_norm: name.toLowerCase(),
    type,
  });
  graph.seedEdge(ENTITY_MENTION_TYPE, EPISODE_ID, id);
}

function seedCognitive(id: string, label: string, text: string): void {
  graph.seedNode(id, [label, 'Memory', 'AionNode'], { text });
  graph.seedEdge('EXTRACTED_FROM', id, EPISODE_ID);
}

function buildContext(provider: Provider, text = DEFAULT_TEXT): StageContext {
  return {
    driver: graph.driver,
    db: undefined as unknown as SqliteHandle,
    provider,
    episodeId: EPISODE_ID,
    episode: { id: EPISODE_ID, sessionId: 'session-1', text, turns: [] },
    logger,
    now: NOW,
  };
}

describe('SemanticRelationshipStage', () => {
  it('skips an episode with no text', async () => {
    const stage = new SemanticRelationshipStage();
    const outcome = await stage.run(
      buildContext(
        stubProvider(async () => ({ relationships: [] })),
        '   ',
      ),
    );

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'episode has no text to infer relationships from',
    });
  });

  it('skips when fewer than two candidates exist', async () => {
    seedEntity('entity-1', 'Aion', 'project');
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(
      buildContext(stubProvider(async () => ({ relationships: [] }))),
    );

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'fewer than two entities or cognitive nodes to relate',
    });
  });

  it('excludes a Goal from the candidate set, leaving too few to relate', async () => {
    seedEntity('entity-1', 'Aion', 'project');
    seedCognitive('goal-1', 'Goal', 'ship the worker');
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(
      buildContext(stubProvider(async () => ({ relationships: [] }))),
    );

    // Only Decision, Insight, and Concept are claim-bearing; the Goal never reaches the
    // candidate list, so one entity is all that remains.
    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'fewer than two entities or cognitive nodes to relate',
    });
  });

  it('keys the prompt schema off the candidate list and writes a clamped edge with its quote as rationale', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedCognitive('cog-1', 'Decision', 'use SQLite for the queue');
    const generate = async (req: StructuredRequest): Promise<unknown> => {
      expect(req.schema).toMatchObject({
        properties: {
          relationships: {
            items: {
              properties: { source: { enum: ['E1', 'C1'] } },
              required: ['source', 'target', 'type', 'confidence', 'quote'],
            },
          },
        },
      });
      return {
        relationships: [
          { source: 'E1', target: 'C1', type: 'CAUSES', confidence: 1.4, quote: VALID_QUOTE },
        ],
      };
    };
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ relationships: 1 });
    const [edge] = graph.edgesOfType('CAUSES');
    expect(edge?.sourceId).toBe('entity-1');
    expect(edge?.targetId).toBe('cog-1');
    // Confidence 1.4 clamps to 1, and strength rides the same clamped value.
    expect(edge?.strength).toBe(1);
    expect(edge?.confidence).toBe(1);
    expect(edge?.rationale).toBe(VALID_QUOTE);
    expect(edge?.provenance).toEqual(['reflection_semantic_relationships']);
    expect(edge?.count).toBe(0);
  });

  it('drops a proposal whose quote does not appear in the episode text', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        {
          source: 'E1',
          target: 'E2',
          type: 'RELATED_TO',
          confidence: 0.7,
          quote: 'words nowhere in the episode',
        },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 0 });
    expect(graph.edgesOfType('RELATED_TO')).toHaveLength(0);
  });

  it('drops a proposal with a missing or empty quote', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'RELATED_TO', confidence: 0.7 },
        { source: 'E1', target: 'E2', type: 'SIMILAR', confidence: 0.7, quote: '   ' },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 0 });
  });

  it('applies a fallback confidence when the model omits the optional field', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedCognitive('cog-1', 'Decision', 'use SQLite for the queue');
    const generate = async (): Promise<unknown> => ({
      relationships: [{ source: 'E1', target: 'C1', type: 'ENABLES', quote: VALID_QUOTE }],
    });
    const stage = new SemanticRelationshipStage();

    await stage.run(buildContext(stubProvider(generate)));

    const [edge] = graph.edgesOfType('ENABLES');
    expect(edge?.confidence).toBe(0.5);
    expect(edge?.strength).toBe(0.5);
  });

  it('clamps a negative confidence to zero', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'RELATED_TO', confidence: -0.5, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    await stage.run(buildContext(stubProvider(generate)));

    const [edge] = graph.edgesOfType('RELATED_TO');
    expect(edge?.confidence).toBe(0);
  });

  it('drops a proposal referencing a key the candidate list never issued', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E9', type: 'RELATED_TO', confidence: 0.7, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 0 });
    expect(graph.edgesOfType('RELATED_TO')).toHaveLength(0);
  });

  it('drops a self-referencing proposal', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E1', type: 'RELATED_TO', confidence: 0.7, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 0 });
  });

  it('drops a proposal outside the sanctioned relationship types', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'BEFRIENDS', confidence: 0.7, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 0 });
  });

  it('writes the two relationship types the catalog had no path for', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'CONTRADICTS', confidence: 0.7, quote: VALID_QUOTE },
        { source: 'E2', target: 'E1', type: 'SIMILAR', confidence: 0.8, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 2 });
    expect(graph.edgesOfType('CONTRADICTS')).toHaveLength(1);
    expect(graph.edgesOfType('SIMILAR')).toHaveLength(1);
  });

  it('dedupes a repeated (type, source, target) proposal within one run', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'RELATED_TO', confidence: 0.6, quote: VALID_QUOTE },
        { source: 'E1', target: 'E2', type: 'RELATED_TO', confidence: 0.9, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ relationships: 1 });
    expect(graph.edgesOfType('RELATED_TO')).toHaveLength(1);
  });

  it('writes an undirected type regardless of which candidate the model names first', async () => {
    seedEntity('entity-a', 'Alpha', 'concept');
    seedEntity('entity-z', 'Zulu', 'concept');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E2', target: 'E1', type: 'ANALOGOUS_TO', confidence: 0.5, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();

    await stage.run(buildContext(stubProvider(generate)));

    expect(graph.edgesOfType('ANALOGOUS_TO')).toHaveLength(1);
  });

  it('fails on a response that does not match the extraction schema', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const stage = new SemanticRelationshipStage();

    const outcome = await stage.run(
      buildContext(
        stubProvider(async () => ({ relationships: [{ source: 1, target: 2, type: 'CAUSES' }] })),
      ),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('invalid shape');
  });

  it('fails when the model call throws, without throwing itself', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    const stage = new SemanticRelationshipStage();

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

  it('reports a failed stage with partial counts when a graph write fails mid-run', async () => {
    seedEntity('entity-1', 'Ryan', 'person');
    seedEntity('entity-2', 'Aion', 'project');
    seedCognitive('cog-1', 'Decision', 'use SQLite for the queue');
    const generate = async (): Promise<unknown> => ({
      relationships: [
        { source: 'E1', target: 'E2', type: 'RELATED_TO', confidence: 0.6, quote: VALID_QUOTE },
        { source: 'E1', target: 'C1', type: 'CAUSES', confidence: 0.6, quote: VALID_QUOTE },
      ],
    });
    const stage = new SemanticRelationshipStage();
    const original = graph.executeQuery.bind(graph);
    let calls = 0;
    graph.executeQuery = async (cypher: string, parameters: Record<string, unknown>) => {
      calls += 1;
      // Calls 1-2 are the entity and cognitive reads; the first edge write is call 3.
      if (calls === 4) {
        throw new Error('graph unreachable');
      }
      return original(cypher, parameters);
    };

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('wrote 1 of 2');
    expect(outcome.counts).toEqual({ relationships: 1 });
  });
});

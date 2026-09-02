import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CognitiveExtractionStage } from './cognitive.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  TEMPORAL_CLASS_PROPERTY,
  VALID_HORIZON_PROPERTY,
} from '../../../infrastructure/graph/claim-key-queries.js';
import {
  deriveCognitiveNodeId,
  TEXT_NORM_PROPERTY,
} from '../../../infrastructure/graph/cognitive-queries.js';
import { ENTITY_MENTION_TYPE } from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { fromGraphDateTime } from '../../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type {
  Provider,
  StructuredRequest,
  Vector,
} from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { readingHorizon } from '../../domain/claim-key.js';
import { foldName } from '../../domain/name-fold.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');
const OCCURRED_AT = new Date('2026-08-28T09:00:00.000Z');

const SUBJECT_ID = 'entity-postgres';

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

/** One entity this episode mentions, which is the whole scope a claim subject resolves against. */
function seedMentionedEntity(name: string, id: string): void {
  graph.seedNode(id, ['Entity', 'AionNode'], { name, name_norm: foldName(name), type: 'tool' });
  graph.seedEdge(ENTITY_MENTION_TYPE, EPISODE_ID, id);
}

function buildContext(
  provider: Provider,
  text = 'user: ship it\nassistant: shipping now',
  summary?: string,
): StageContext {
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
      ...(summary === undefined ? {} : { summary }),
    },
    logger,
    now: NOW,
    occurredAt: OCCURRED_AT,
    pipelineVersion: PIPELINE_VERSION,
  };
}

describe('CognitiveExtractionStage', () => {
  it('skips an episode with no text', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(
        stubProvider(async () => ({ nodes: [] })),
        '   ',
      ),
    );

    expect(outcome).toEqual({ status: 'skipped', summary: 'episode has no text to extract from' });
    expect(graph.nodesWithLabel('Goal')).toHaveLength(0);
  });

  it('skips when the model finds no cognitive structure', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(buildContext(stubProvider(async () => ({ nodes: [] }))));

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'no cognitive structure found in the episode',
    });
  });

  it('asks the model for an unsampled answer, so two runs of one episode extract the same nodes', async () => {
    const requests: StructuredRequest[] = [];
    const generate: GenerateFn = async (req) => {
      requests.push(req);
      return { nodes: [{ type: 'Insight', text: 'idempotency needs two levels' }] };
    };

    await new CognitiveExtractionStage().run(buildContext(stubProvider(generate)));

    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.think).toBe(false);
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
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
    expect(embedded).toEqual([
      ['ship the worker', 'use SQLite for the queue', 'idempotency needs two levels'],
    ]);

    const goal = graph.nodesWithLabel('Goal')[0];
    expect(goal?.labels).toEqual(expect.arrayContaining(['Goal', 'Memory', 'AionNode']));
    expect(goal?.properties[MEMORY_PROPERTIES.text]).toBe('ship the worker');
    expect(goal?.properties.status).toBe('active');
    expect(goal?.properties.priority).toBe('high');
    expect(goal?.properties[MEMORY_PROPERTIES.contentVector]).toEqual([1, 0.1, 0.2]);
    expect(fromGraphDateTime(goal?.properties[BITEMPORAL_PROPERTIES.occurredAt])).toEqual(
      OCCURRED_AT,
    );

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

  it('spends no cap slot on a node whose text is blank', async () => {
    const generate = async (): Promise<unknown> => ({
      nodes: [
        { type: 'Concept', text: '   ' },
        { type: 'Concept', text: 'one' },
        { type: 'Concept', text: 'two' },
      ],
    });
    const stage = new CognitiveExtractionStage({ maxNodes: 2 });

    const outcome = await stage.run(buildContext(stubProvider(generate)));

    expect(outcome.counts).toEqual({ cognitive: 2 });
    expect(graph.nodesWithLabel('Concept')).toHaveLength(2);
  });

  it('fails on a response that is not a list of nodes at all', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(stubProvider(async () => ({ nodes: 'a decision was made' }))),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('invalid shape');
  });

  it('fails when every node the model returned carries a type outside the nine', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(stubProvider(async () => ({ nodes: [{ type: 'NotAType', text: 'x' }] }))),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('none of them a described type');
  });

  it('keeps the described nodes when one of them carries an invented type', async () => {
    const stage = new CognitiveExtractionStage();
    const outcome = await stage.run(
      buildContext(
        stubProvider(async () => ({
          nodes: [
            { type: 'Problem', text: 'two workers can process one refund' },
            { type: 'Decision', text: 'use a row-level lock', rationale: 'one system, not two' },
          ],
        })),
      ),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ cognitive: 1 });
    expect(graph.nodesWithLabel('Decision')).toHaveLength(1);
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
    const generate = async (): Promise<unknown> => ({
      nodes: [{ type: 'Concept', text: 'graceful degradation' }],
    });
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
    graph.executeQuery = async (cypher: string, parameters: Record<string, unknown>) => {
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

  describe('restatement refusal (D3)', () => {
    const SUMMARY = 'closed out the duplicate remittance investigation';

    it('drops a Goal a second model call judges a restatement of the summary, keeping an unrelated Decision', async () => {
      let calls = 0;
      const generate = async (req: StructuredRequest): Promise<unknown> => {
        calls += 1;
        if (calls === 1) {
          return {
            nodes: [
              { type: 'Goal', text: 'Close out the duplicate remittance investigation.' },
              {
                type: 'Decision',
                text: 'use SQLite for the queue',
                rationale: 'no Redis dependency',
              },
            ],
          };
        }
        // The one Goal is the only Goal/Plan candidate, so it is the only key on offer.
        expect(req.schema).toMatchObject({ properties: { restated: { items: { enum: ['R1'] } } } });
        return { restated: ['R1'] };
      };
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate), undefined, SUMMARY));

      expect(calls).toBe(2);
      expect(outcome.status).toBe('ok');
      expect(outcome.counts).toEqual({ cognitive: 1 });
      expect(graph.nodesWithLabel('Goal')).toHaveLength(0);
      expect(graph.nodesWithLabel('Decision')).toHaveLength(1);
    });

    it('asks the validation call for an unsampled answer, so one candidate set is judged once', async () => {
      const requests: StructuredRequest[] = [];
      const generate = async (req: StructuredRequest): Promise<unknown> => {
        requests.push(req);
        return requests.length === 1
          ? { nodes: [{ type: 'Goal', text: 'Close out the duplicate remittance investigation.' }] }
          : { restated: [] };
      };

      await new CognitiveExtractionStage().run(
        buildContext(stubProvider(generate), undefined, SUMMARY),
      );

      expect(requests).toHaveLength(2);
      expect(requests[1]?.temperature).toBe(0);
      expect(requests[1]?.think).toBe(false);
    });

    it('keeps a Goal the validation call confirms adds information beyond the summary', async () => {
      let calls = 0;
      const generate = async (): Promise<unknown> => {
        calls += 1;
        if (calls === 1) {
          return {
            nodes: [{ type: 'Goal', text: 'Migrate the remaining callers before the flag flips.' }],
          };
        }
        return { restated: [] };
      };
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate), undefined, SUMMARY));

      expect(calls).toBe(2);
      expect(outcome.counts).toEqual({ cognitive: 1 });
      expect(graph.nodesWithLabel('Goal')).toHaveLength(1);
    });

    it('never calls the validation model when the episode carries no summary', async () => {
      let calls = 0;
      const generate = async (): Promise<unknown> => {
        calls += 1;
        return { nodes: [{ type: 'Goal', text: 'ship the worker' }] };
      };
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate)));

      expect(calls).toBe(1);
      expect(outcome.counts).toEqual({ cognitive: 1 });
      expect(graph.nodesWithLabel('Goal')).toHaveLength(1);
    });

    it('retries the validation call once on an unusable answer, then drops the candidate on a second failure', async () => {
      let calls = 0;
      const generate = async (): Promise<unknown> => {
        calls += 1;
        if (calls === 1) {
          return {
            nodes: [{ type: 'Plan', text: 'Close out the duplicate remittance investigation.' }],
          };
        }
        // Neither validation attempt matches the RestatementOutputSchema shape.
        return { restated: 'not-an-array' };
      };
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate), undefined, SUMMARY));

      expect(calls).toBe(3);
      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toBe(
        'every extracted node restated the episode summary and was dropped',
      );
      expect(outcome.counts).toEqual({ cognitive: 0 });
      expect(graph.nodesWithLabel('Plan')).toHaveLength(0);
    });

    it('fails the stage when the validation call never lands, keeping the candidates', async () => {
      let calls = 0;
      const generate = async (): Promise<unknown> => {
        calls += 1;
        if (calls === 1) {
          return {
            nodes: [{ type: 'Plan', text: 'Close out the duplicate remittance investigation.' }],
          };
        }
        throw new Error('ollama unreachable');
      };
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate), undefined, SUMMARY));

      // The retry owes the episode its Plan node: nothing else re-extracts one, so a transport
      // failure must not read as the model judging the candidate a restatement.
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toContain('restatement validation failed');
      expect(outcome.summary).toContain('ollama unreachable');
    });
  });

  describe('claim keys', () => {
    it('keys a fact-bearing claim to the entity the episode mentions and the attribute it asserts', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Decision',
            text: 'the queue moves off Postgres onto its own SQLite file',
            subject_entity: 'Postgres',
            aspect: 'Queue Store',
            temporal_class: 'standing',
          },
        ],
      });
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate)));

      expect(outcome.status).toBe('ok');
      const [decision] = graph.nodesWithLabel('Decision');
      expect(decision?.properties[CLAIM_SUBJECT_PROPERTY]).toBe(SUBJECT_ID);
      expect(decision?.properties[CLAIM_ASPECT_PROPERTY]).toBe('queue store');
      expect(decision?.properties[TEMPORAL_CLASS_PROPERTY]).toBe('standing');
      expect(decision?.properties[VALID_HORIZON_PROPERTY]).toBeUndefined();
    });

    it('dates a reading horizon from the episode clock and the horizon days it was built with', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Event',
            text: 'the queue table held 4.2 million rows this morning',
            subject_entity: 'Postgres',
            aspect: 'queue table row count',
            temporal_class: 'reading',
          },
        ],
      });
      const stage = new CognitiveExtractionStage({ readingHorizonDays: 7 });

      await stage.run(buildContext(stubProvider(generate)));

      const [event] = graph.nodesWithLabel('Event');
      expect(fromGraphDateTime(event?.properties[VALID_HORIZON_PROPERTY])).toEqual(
        readingHorizon(OCCURRED_AT, 7),
      );
    });

    it('keeps the claim and drops only the temporal class when the model invents a fourth one', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Insight',
            text: 'the queue write is the contended one',
            subject_entity: 'Postgres',
            aspect: 'contended write',
            temporal_class: 'projection',
          },
        ],
      });
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate)));

      expect(outcome.status).toBe('ok');
      expect(outcome.counts).toEqual({ cognitive: 1 });
      const [insight] = graph.nodesWithLabel('Insight');
      expect(insight?.properties[MEMORY_PROPERTIES.text]).toBe(
        'the queue write is the contended one',
      );
      expect(insight?.properties[TEMPORAL_CLASS_PROPERTY]).toBeUndefined();
      expect(insight?.properties[CLAIM_SUBJECT_PROPERTY]).toBe(SUBJECT_ID);
      expect(insight?.properties[CLAIM_ASPECT_PROPERTY]).toBe('contended write');
    });

    it('declines subject and aspect together when the aspect is a sentence rather than an attribute', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Concept',
            text: 'the queue store is its own SQLite file',
            subject_entity: 'Postgres',
            aspect:
              'the store the reflection queue writes to now that it no longer shares the main transaction',
            temporal_class: 'standing',
          },
        ],
      });
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate)));

      expect(outcome.counts).toEqual({ cognitive: 1 });
      const [concept] = graph.nodesWithLabel('Concept');
      expect(concept?.properties[CLAIM_SUBJECT_PROPERTY]).toBeUndefined();
      expect(concept?.properties[CLAIM_ASPECT_PROPERTY]).toBeUndefined();
      expect(concept?.properties[TEMPORAL_CLASS_PROPERTY]).toBe('standing');
    });

    it('declines the key when the episode mentions nothing the subject names', async () => {
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Decision',
            text: 'the queue moves off Postgres onto its own SQLite file',
            subject_entity: 'Postgres',
            aspect: 'queue store',
            temporal_class: 'standing',
          },
        ],
      });
      const stage = new CognitiveExtractionStage();

      const outcome = await stage.run(buildContext(stubProvider(generate)));

      expect(outcome.counts).toEqual({ cognitive: 1 });
      const [decision] = graph.nodesWithLabel('Decision');
      expect(decision?.properties[CLAIM_SUBJECT_PROPERTY]).toBeUndefined();
      expect(decision?.properties[CLAIM_ASPECT_PROPERTY]).toBeUndefined();
    });

    it('keys nothing on a Goal, whatever the model returned for it', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Goal',
            text: 'move every queue write off Postgres',
            subject_entity: 'Postgres',
            aspect: 'queue store',
            temporal_class: 'standing',
          },
        ],
      });
      const stage = new CognitiveExtractionStage();

      await stage.run(buildContext(stubProvider(generate)));

      const [goal] = graph.nodesWithLabel('Goal');
      expect(goal?.properties[CLAIM_SUBJECT_PROPERTY]).toBeUndefined();
      expect(goal?.properties[CLAIM_ASPECT_PROPERTY]).toBeUndefined();
      expect(goal?.properties[TEMPORAL_CLASS_PROPERTY]).toBeUndefined();
    });

    it('resolves no subject and stores no key when the keyed close is off', async () => {
      seedMentionedEntity('Postgres', SUBJECT_ID);
      const generate = async (): Promise<unknown> => ({
        nodes: [
          {
            type: 'Decision',
            text: 'the queue moves off Postgres onto its own SQLite file',
            subject_entity: 'Postgres',
            aspect: 'queue store',
            temporal_class: 'reading',
          },
        ],
      });
      const stage = new CognitiveExtractionStage({ keyedCloseMode: 'off' });

      await stage.run(buildContext(stubProvider(generate)));

      const [decision] = graph.nodesWithLabel('Decision');
      expect(decision?.properties[CLAIM_SUBJECT_PROPERTY]).toBeUndefined();
      expect(decision?.properties[CLAIM_ASPECT_PROPERTY]).toBeUndefined();
      // The class and its horizon answer to the temporal knobs, not to the keyed close.
      expect(decision?.properties[TEMPORAL_CLASS_PROPERTY]).toBe('reading');
      expect(graph.statements.some((statement) => statement.cypher.includes('MENTIONS'))).toBe(
        false,
      );
    });

    it('reports the options it runs on, keyed close and horizon included', () => {
      const stage = new CognitiveExtractionStage();

      expect(stage.describe()).toEqual({
        model: DEFAULTS.models.reflect,
        timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
        maxNodes: DEFAULTS.reflection.maxCognitiveNodes,
        keyedCloseMode: DEFAULTS.reflection.keyedCloseMode,
        familyRelatednessFloor: DEFAULTS.reflection.supersedeFamilyRelatednessFloor,
        readingHorizonDays: DEFAULTS.temporal.readingHorizonDays,
      });
    });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntityFakeGraph, fakeProvider, type FakeProvider } from './entities.fixture.js';
import { ENTITY_EXTRACTION_METHOD, EntityExtractionStage } from './entities.js';
import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  ENTITY_MENTION_TYPE,
  ENTITY_PARTICIPATION_TYPE,
  findEpisodeEntities,
} from '../../../infrastructure/graph/entity-queries.js';
import type { EpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';

const EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const MEMBER_ID = 'member-1';
const OCCURRED_AT = new Date('2026-08-28T09:00:00.000Z');
const NOW = new Date('2026-08-28T09:05:00.000Z');

const EPISODE_TEXT = [
  'summary: pairing on the reflection worker',
  'user: Ryan Huber and I paired on Aion today',
  'assistant: the entity stage landed',
].join('\n');

const EXTRACTION = {
  entities: [
    { name: 'Ryan Huber', type: 'person', context: 'paired on the work' },
    { name: 'Aion', type: 'project', context: 'the memory substrate' },
  ],
};

let graph: EntityFakeGraph;
let store: SqliteStore;
let dataDir: string;

function episode(text = EPISODE_TEXT): EpisodeContext {
  return {
    id: EPISODE_ID,
    sessionId: SESSION_ID,
    text,
    occurredAt: OCCURRED_AT,
    turns: [],
  };
}

function context(provider: FakeProvider, text?: string): StageContext {
  return {
    driver: graph.driver,
    db: store.db,
    provider,
    episodeId: EPISODE_ID,
    episode: episode(text),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
  };
}

function seedEpisode(): void {
  graph.seedNode(SESSION_ID, ['Session', 'AionNode']);
  graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: EPISODE_TEXT,
    [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
    [BITEMPORAL_PROPERTIES.occurredAt]: OCCURRED_AT,
  });
  graph.seedEdge(CONTAINMENT_TYPE, EPISODE_ID, SESSION_ID);
}

/** The backbone as `bootstrapBackbone` writes it: `Member` plus `Entity`, structural, no vectors. */
function seedMember(name: string): void {
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode'], {
    type: 'member',
    [STRUCTURAL_PROPERTY]: true,
    [ENTITY_NAME_PROPERTY]: name,
    [ENTITY_NAME_NORM_PROPERTY]: name.toLowerCase(),
  });
}

function entityNames(): string[] {
  return graph
    .entities()
    .map((node) => node.properties[ENTITY_NAME_PROPERTY] as string)
    .sort();
}

beforeEach(() => {
  graph = new EntityFakeGraph();
  seedEpisode();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entities-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('canonicalization', () => {
  it('writes one node per extracted identity, with its text, provenance and both vectors', async () => {
    const provider = fakeProvider({ generate: [EXTRACTION] });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ entities: 2, mentions: 2 });
    expect(entityNames()).toEqual(['Aion', 'Ryan Huber']);

    const aion = graph
      .entities()
      .find((node) => node.properties[ENTITY_NAME_NORM_PROPERTY] === 'aion');
    expect(aion?.labels).toContain('Memory');
    expect(aion?.properties[MEMORY_PROPERTIES.text]).toBe('Aion (project): the memory substrate');
    expect(aion?.properties[MEMORY_PROPERTIES.sourceEpisodeId]).toBe(EPISODE_ID);
    expect(aion?.properties[MEMORY_PROPERTIES.extractionMethod]).toBe(ENTITY_EXTRACTION_METHOD);
    expect(aion?.properties[ENTITY_NAME_VECTOR_PROPERTY]).toBeDefined();
    expect(aion?.properties[MEMORY_PROPERTIES.contentVector]).toBeDefined();
  });

  it('embeds the folded name and the stored text, which is what the two indexes are searched by', async () => {
    const provider = fakeProvider({ generate: [EXTRACTION] });
    await new EntityExtractionStage().run(context(provider));

    expect(provider.embedCalls).toHaveLength(1);
    expect(provider.embedCalls[0]).toEqual([
      'ryan huber',
      'Ryan Huber (person): paired on the work',
      'aion',
      'Aion (project): the memory substrate',
    ]);
  });

  it('embeds every alias with the name, so a nickname is inside the vector that nominates', async () => {
    const provider = fakeProvider({
      generate: [
        {
          entities: [
            { name: 'Aion', type: 'project', context: '', aliases: ['the substrate', 'AION'] },
          ],
        },
      ],
    });
    await new EntityExtractionStage().run(context(provider));

    expect(provider.embedCalls[0]?.[0]).toBe('aion\nthe substrate');
  });

  it('re-embeds the name when an alias changes its input, and leaves it alone when nothing did', async () => {
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));

    const widened = fakeProvider({
      generate: [
        { entities: [{ name: 'Aion', type: 'project', context: '', aliases: ['aion2'] }] },
      ],
    });
    await new EntityExtractionStage().run(context(widened));
    expect(widened.embedCalls[0]).toEqual(['aion\naion2']);

    const unchanged = fakeProvider({
      generate: [
        { entities: [{ name: 'Aion', type: 'project', context: '', aliases: ['aion2'] }] },
      ],
    });
    await new EntityExtractionStage().run(context(unchanged));
    expect(unchanged.embedCalls).toEqual([]);
  });

  it('counts every reading and keeps the most observed label, without forking the identity', async () => {
    const readings = [
      { entities: [{ name: 'Aion', type: 'project', context: 'the substrate' }] },
      { entities: [{ name: 'Aion', type: 'tool', context: 'the substrate' }] },
      { entities: [{ name: 'Aion', type: 'tool', context: 'the substrate' }] },
    ];
    for (const reading of readings) {
      await new EntityExtractionStage().run(context(fakeProvider({ generate: [reading] })));
    }

    const aion = graph
      .entities()
      .filter((node) => node.properties[ENTITY_NAME_NORM_PROPERTY] === 'aion');
    expect(aion).toHaveLength(1);
    expect(aion[0]?.properties.type).toBe('tool');
    expect(aion[0]?.properties.type_counts).toBe('{"project":1,"tool":2}');
  });

  it('points MENTIONS at the entity and PARTICIPATES_IN at the episode', async () => {
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));

    const mentions = graph.edgesOfType(ENTITY_MENTION_TYPE);
    const participations = graph.edgesOfType(ENTITY_PARTICIPATION_TYPE);
    expect(mentions.every((edge) => edge.sourceId === EPISODE_ID)).toBe(true);
    expect(mentions).toHaveLength(2);
    expect(
      participations.filter((edge) => edge.targetId === EPISODE_ID).map((edge) => edge.sourceId),
    ).toEqual(mentions.map((edge) => edge.targetId));
  });

  it('bumps the salience signals recall and maintenance read', async () => {
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));

    for (const node of graph.entities()) {
      expect(node.properties[LAST_ACCESSED_PROPERTY]).toBeDefined();
      expect(node.properties[ACCESS_COUNT_PROPERTY]).toBe(1);
    }
  });

  it('converges on a second run: no new node, no second edge, no second embedding', async () => {
    const first = fakeProvider({ generate: [EXTRACTION] });
    await new EntityExtractionStage().run(context(first));
    const ids = graph.entities().map((node) => node.id);

    const second = fakeProvider({ generate: [EXTRACTION] });
    const outcome = await new EntityExtractionStage().run(context(second));

    expect(graph.entities().map((node) => node.id)).toEqual(ids);
    expect(outcome.counts).toEqual({ entities: 0, mentions: 2 });
    expect(graph.edgesOfType(ENTITY_MENTION_TYPE)).toHaveLength(2);
    // The vectors are already there, so the second run has nothing left to embed.
    expect(second.embedCalls).toEqual([]);
  });

  it('sums the mention count and leaves the structural edge a total no-op', async () => {
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));

    expect(graph.edgesOfType(ENTITY_MENTION_TYPE).map((edge) => edge.count)).toEqual([2, 2]);
    expect(
      graph
        .edgesOfType(ENTITY_PARTICIPATION_TYPE)
        .filter((edge) => edge.sourceId !== EPISODE_ID)
        .map((edge) => edge.count),
    ).toEqual([0, 0]);
  });

  it('hands the entities the next stage needs back off the graph, keyed on the episode', async () => {
    await new EntityExtractionStage().run(context(fakeProvider({ generate: [EXTRACTION] })));

    const found = await findEpisodeEntities(graph.driver, EPISODE_ID);
    expect(found.map((entity) => entity.nameNorm)).toEqual(['aion', 'ryan huber']);
    expect(found.map((entity) => entity.type)).toEqual(['project', 'person']);
  });
});

describe('structural upgrade', () => {
  it('merges into the backbone node instead of forking a second identity for the name', async () => {
    seedMember('Ryan Huber');
    const outcome = await new EntityExtractionStage().run(
      context(fakeProvider({ generate: [EXTRACTION] })),
    );

    expect(entityNames()).toEqual(['Aion', 'Ryan Huber']);
    expect(outcome.counts).toEqual({ entities: 1, mentions: 2 });
    expect(outcome.summary).toContain('1 structural');

    const member = graph.nodes.get(MEMBER_ID);
    expect(graph.edgesOfType(ENTITY_MENTION_TYPE).map((edge) => edge.targetId)).toContain(
      MEMBER_ID,
    );
    // The backbone keeps its own identity: still a member, still without a memory body.
    expect(member?.properties.type).toBe('member');
    expect(member?.properties[MEMORY_PROPERTIES.text]).toBeUndefined();
    expect(member?.properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
    expect(member?.properties[ENTITY_NAME_VECTOR_PROPERTY]).toBeDefined();
    expect(member?.properties[ACCESS_COUNT_PROPERTY]).toBe(1);
  });

  it('matches the backbone on the folded name, whatever case the model returned', async () => {
    seedMember('Ryan Huber');
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'ryan   huber', type: 'person', context: '' }] }],
        }),
      ),
    );

    expect(entityNames()).toEqual(['Ryan Huber']);
    expect(graph.entities()).toHaveLength(1);
  });

  it('routes the speaker to the backbone under whatever name the record called them', async () => {
    seedMember('Ryan Huber');
    const outcome = await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'Ry', type: 'person', context: '', is_speaker: true }] }],
        }),
      ),
    );

    expect(graph.entities()).toHaveLength(1);
    expect(outcome.counts).toEqual({ entities: 0, mentions: 1 });
    const member = graph.nodes.get(MEMBER_ID);
    expect(member?.properties.aliases).toEqual(['Ry', 'ry']);
    expect(member?.properties.aliases_norm).toEqual(['ry']);
  });
});

describe('name-form routing', () => {
  it('routes a separator variant onto the identity that already answers to the squashed name', async () => {
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'proposal-hygiene', type: 'tool', context: '' }] }],
        }),
      ),
    );
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'proposal_hygiene', type: 'topic', context: '' }] }],
        }),
      ),
    );

    expect(entityNames()).toEqual(['proposal-hygiene']);
    const node = graph.entities()[0];
    expect(node?.properties.aliases_norm).toEqual(['proposal_hygiene']);
  });

  it('routes a later record onto the identity holding that spelling as an alias', async () => {
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [
            { entities: [{ name: 'Aion', type: 'project', context: '', aliases: ['the graph'] }] },
          ],
        }),
      ),
    );
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'the graph', type: 'topic', context: '' }] }],
        }),
      ),
    );

    expect(entityNames()).toEqual(['Aion']);
  });

  it('mints its own identity when several holders answer to the name', async () => {
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [
            {
              entities: [
                { name: 'Postgres', type: 'tool', context: '', aliases: ['the store'] },
                { name: 'Valkey', type: 'tool', context: '', aliases: ['the store'] },
              ],
            },
          ],
        }),
      ),
    );
    await new EntityExtractionStage().run(
      context(
        fakeProvider({
          generate: [{ entities: [{ name: 'the store', type: 'tool', context: '' }] }],
        }),
      ),
    );

    expect(entityNames()).toEqual(['Postgres', 'Valkey', 'the store']);
  });
});

describe('refinement', () => {
  it('retries once with the rejected answer in the prompt when the shape is unusable', async () => {
    const provider = fakeProvider({ generate: [{ people: ['Ryan Huber'] }, EXTRACTION] });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('ok');
    expect(provider.generateCalls).toHaveLength(2);
    const refinement = provider.generateCalls[1]?.messages ?? [];
    expect(refinement[1]?.content).toContain('{"people":["Ryan Huber"]}');
    expect(refinement[1]?.content).toContain('did not match the required shape');
    expect(entityNames()).toEqual(['Aion', 'Ryan Huber']);
  });

  it('retries when the first pass named nothing, and says so in the refinement', async () => {
    const provider = fakeProvider({ generate: [{ entities: [] }, EXTRACTION] });
    await new EntityExtractionStage().run(context(provider));

    expect(provider.generateCalls).toHaveLength(2);
    expect(provider.generateCalls[1]?.messages[1]?.content).toContain('named no entities');
  });

  it('retries a call that failed outright', async () => {
    const provider = fakeProvider({ generate: [new Error('model unreachable'), EXTRACTION] });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('ok');
    expect(provider.generateCalls[1]?.messages[1]?.content).toContain('model unreachable');
  });

  it('accepts an empty second answer as the episode naming nothing', async () => {
    const provider = fakeProvider({ generate: [{ entities: [] }, { entities: [] }] });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome).toMatchObject({ status: 'ok', counts: { entities: 0, mentions: 0 } });
    expect(graph.entities()).toHaveLength(0);
  });

  it('never makes a third call, and fails the stage rather than guessing', async () => {
    const provider = fakeProvider({ generate: [{ bad: true }, { worse: true }] });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('unusable shape twice');
    expect(provider.generateCalls).toHaveLength(2);
    expect(graph.entities()).toHaveLength(0);
  });

  it('fails without writing when both calls fail', async () => {
    const provider = fakeProvider({
      generate: [new Error('down'), new Error('still down')],
    });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('still down');
    expect(graph.entities()).toHaveLength(0);
  });

  it('asks the model for a structured answer without reasoning, under its own abort signal', async () => {
    const provider = fakeProvider({ generate: [EXTRACTION] });
    await new EntityExtractionStage().run(context(provider));

    const request = provider.generateCalls[0];
    expect(request?.think).toBe(false);
    expect(request?.temperature).toBe(0);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.schema.required).toEqual(['entities']);
  });
});

describe('degradation', () => {
  it('skips an episode with no text rather than calling the model', async () => {
    const provider = fakeProvider({ generate: [EXTRACTION] });
    const outcome = await new EntityExtractionStage().run(context(provider, '   '));

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(provider.generateCalls).toEqual([]);
  });

  it('stores the entities when embedding is down and leaves their vectors pending', async () => {
    const provider = fakeProvider({ generate: [EXTRACTION], embedFails: true });
    const outcome = await new EntityExtractionStage().run(context(provider));

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toContain('vectors deferred');
    expect(entityNames()).toEqual(['Aion', 'Ryan Huber']);
    for (const node of graph.entities()) {
      expect(node.properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
      // `:Memory` plus a `text` and no vector is exactly the marker the worker's drain reads.
      expect(node.labels).toContain('Memory');
      expect(node.properties[MEMORY_PROPERTIES.text]).toBeDefined();
    }
    expect(graph.edgesOfType(ENTITY_MENTION_TYPE)).toHaveLength(2);
  });
});

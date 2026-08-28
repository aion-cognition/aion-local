import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import type { EpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { SUPERSEDES_TYPE } from '../../../infrastructure/graph/relationships.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { StructuredRequest } from '../../../infrastructure/providers/types.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { listSupersessionProposals } from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { StageContext } from '../../domain/stage.js';
import { seedFactNode, SupersessionFakeGraph } from './supersession.fixture.js';
import { SupersessionStage } from './supersession.js';

const EPISODE_ID = 'episode-2';
const PRIOR_EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');

/** Two near-parallel unit vectors: cosine ≈ 0.99, comfortably over the neighbour threshold. */
const CLOSE = [1, 0.1, 0];
const ALSO_CLOSE = [1, 0.14, 0];
const FAR = [0, 1, 0];

let graph: SupersessionFakeGraph;
let store: SqliteStore;
let dataDir: string;
let requests: StructuredRequest[];
let responses: unknown[];

function context(): StageContext {
  return {
    driver: graph.driver,
    db: store.db,
    provider: {
      embed: async () => [],
      generate: async (req: StructuredRequest) => {
        requests.push(req);
        const next = responses.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next ?? { contradicts: false, confidence: 0 };
      },
    },
    episodeId: EPISODE_ID,
    episode: episode(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
  };
}

function episode(): EpisodeContext {
  return { id: EPISODE_ID, sessionId: SESSION_ID, text: 'episode body', turns: [] };
}

function seedEpisode(id: string): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: 'episode body',
    [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
  });
}

function supersedesEdges(): { sourceId: string; targetId: string }[] {
  return graph.edgesOfType(SUPERSEDES_TYPE).map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
  }));
}

function validUntil(id: string): unknown {
  return graph.nodes.get(id)?.properties[BITEMPORAL_PROPERTIES.validUntil];
}

/** One prior Decision and one new Decision that sits next to it in embedding space. */
function seedContradictingPair(): void {
  seedEpisode(PRIOR_EPISODE_ID);
  seedEpisode(EPISODE_ID);
  seedFactNode(graph, {
    id: 'decision-old',
    label: 'Decision',
    text: 'Queue writes stay in the main Postgres transaction.',
    vector: CLOSE,
    episodeId: PRIOR_EPISODE_ID,
  });
  seedFactNode(graph, {
    id: 'decision-new',
    label: 'Decision',
    text: 'Queue writes move to a separate SQLite database.',
    vector: ALSO_CLOSE,
    episodeId: EPISODE_ID,
  });
}

beforeEach(() => {
  graph = new SupersessionFakeGraph();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-supersession-stage-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  requests = [];
  responses = [];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SupersessionStage', () => {
  it('skips an episode with no fact-bearing nodes', async () => {
    seedEpisode(EPISODE_ID);

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('skipped');
    expect(requests).toHaveLength(0);
  });

  it('skips fact nodes that have no content vector yet', async () => {
    seedEpisode(EPISODE_ID);
    seedFactNode(graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'A decision whose embedding has not landed.',
      episodeId: EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toContain('content vectors');
    expect(requests).toHaveLength(0);
  });

  it('supersedes the old node when the judgment clears the auto threshold', async () => {
    seedContradictingPair();
    responses = [{ contradicts: true, confidence: 0.92, rationale: 'the new decision reverses it' }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ supersessions: 1, supersessionProposals: 0 });
    expect(validUntil('decision-old')).toBeDefined();
    expect(supersedesEdges()).toEqual([{ sourceId: 'decision-new', targetId: 'decision-old' }]);
    expect(listSupersessionProposals(store.db)).toEqual([]);
  });

  it('records a proposal and leaves the graph alone below the auto threshold', async () => {
    seedContradictingPair();
    responses = [{ contradicts: true, confidence: 0.6, rationale: 'possibly a reversal' }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 1 });
    expect(validUntil('decision-old')).toBeUndefined();
    expect(supersedesEdges()).toEqual([]);

    const proposals = listSupersessionProposals(store.db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      oldId: 'decision-old',
      newId: 'decision-new',
      confidence: 0.6,
      rationale: 'possibly a reversal',
      episodeId: EPISODE_ID,
      createdAt: NOW.toISOString(),
      resolvedAt: null,
    });
  });

  it('treats a confidence exactly at the threshold as an auto-apply', async () => {
    seedContradictingPair();
    responses = [{ contradicts: true, confidence: 0.85 }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.counts?.supersessions).toBe(1);
    expect(listSupersessionProposals(store.db)).toEqual([]);
  });

  it('proposes rather than applies when the model states no confidence', async () => {
    seedContradictingPair();
    responses = [{ contradicts: true }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 1 });
    expect(listSupersessionProposals(store.db)[0]?.confidence).toBe(0.5);
  });

  it('writes nothing when the model says the pair does not contradict', async () => {
    seedContradictingPair();
    responses = [{ contradicts: false, confidence: 0.9 }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
    expect(validUntil('decision-old')).toBeUndefined();
    expect(listSupersessionProposals(store.db)).toEqual([]);
  });

  it('never judges an episode against its own siblings or a different kind', async () => {
    seedEpisode(EPISODE_ID);
    seedFactNode(graph, {
      id: 'decision-a',
      label: 'Decision',
      text: 'A decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(graph, {
      id: 'decision-b',
      label: 'Decision',
      text: 'B decision.',
      vector: ALSO_CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(graph, {
      id: 'insight-prior',
      label: 'Insight',
      text: 'A prior insight sitting in the same place.',
      vector: CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(context());

    expect(requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
  });

  it('ignores a neighbour that is already superseded or too far away', async () => {
    seedEpisode(EPISODE_ID);
    seedFactNode(graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'The new decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(graph, {
      id: 'decision-closed',
      label: 'Decision',
      text: 'Already superseded.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
      superseded: true,
    });
    seedFactNode(graph, {
      id: 'decision-unrelated',
      label: 'Decision',
      text: 'About something else entirely.',
      vector: FAR,
      episodeId: PRIOR_EPISODE_ID,
    });

    const outcome = await new SupersessionStage().run(context());

    expect(requests).toHaveLength(0);
    expect(outcome.status).toBe('ok');
  });

  it('bounds the run at maxJudgments however many close neighbours exist', async () => {
    seedEpisode(EPISODE_ID);
    for (let index = 0; index < 4; index += 1) {
      seedFactNode(graph, {
        id: `decision-new-${index}`,
        label: 'Decision',
        text: `New decision ${index}.`,
        vector: CLOSE,
        episodeId: EPISODE_ID,
      });
      seedFactNode(graph, {
        id: `decision-prior-${index}`,
        label: 'Decision',
        text: `Prior decision ${index}.`,
        vector: ALSO_CLOSE,
        episodeId: PRIOR_EPISODE_ID,
      });
    }

    const outcome = await new SupersessionStage({ maxJudgments: 3, maxNeighbors: 2 }).run(context());

    expect(requests).toHaveLength(3);
    expect(outcome.status).toBe('ok');
  });

  it('bounds the subjects it checks', async () => {
    seedEpisode(EPISODE_ID);
    for (let index = 0; index < 4; index += 1) {
      seedFactNode(graph, {
        id: `decision-new-${index}`,
        label: 'Decision',
        text: `New decision ${index}.`,
        vector: CLOSE,
        episodeId: EPISODE_ID,
      });
    }
    seedFactNode(graph, {
      id: 'decision-prior',
      label: 'Decision',
      text: 'The one prior decision.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });

    await new SupersessionStage({ maxSubjects: 2 }).run(context());

    expect(requests).toHaveLength(2);
  });

  it('sends one judgment per pair, with both statements and thinking off', async () => {
    seedContradictingPair();
    responses = [{ contradicts: false, confidence: 0.1 }];

    await new SupersessionStage().run(context());

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.think).toBe(false);
    expect(request.signal).toBeDefined();
    const prompt = request.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Queue writes stay in the main Postgres transaction.');
    expect(prompt).toContain('Queue writes move to a separate SQLite database.');
  });

  it('fails when every judgment fails, and writes nothing', async () => {
    seedContradictingPair();
    responses = [new Error('ollama unreachable')];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('judgment');
    expect(validUntil('decision-old')).toBeUndefined();
    expect(listSupersessionProposals(store.db)).toEqual([]);
  });

  it('keeps going when one judgment of several fails', async () => {
    seedEpisode(EPISODE_ID);
    seedFactNode(graph, {
      id: 'decision-new',
      label: 'Decision',
      text: 'The new decision.',
      vector: CLOSE,
      episodeId: EPISODE_ID,
    });
    seedFactNode(graph, {
      id: 'decision-prior-a',
      label: 'Decision',
      text: 'Prior decision A.',
      vector: ALSO_CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });
    seedFactNode(graph, {
      id: 'decision-prior-b',
      label: 'Decision',
      text: 'Prior decision B.',
      vector: CLOSE,
      episodeId: PRIOR_EPISODE_ID,
    });
    responses = [new Error('one bad call'), { contradicts: true, confidence: 0.9 }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.supersessions).toBe(1);
  });

  it('fails on a shape the judgment schema rejects', async () => {
    seedContradictingPair();
    responses = [{ verdict: 'yes' }];

    const outcome = await new SupersessionStage().run(context());

    expect(outcome.status).toBe('failed');
    expect(listSupersessionProposals(store.db)).toEqual([]);
  });

  it('re-running after an auto-supersession judges nothing and writes nothing new', async () => {
    seedContradictingPair();
    responses = [{ contradicts: true, confidence: 0.92 }];
    await new SupersessionStage().run(context());

    const before = supersedesEdges();
    requests = [];
    const outcome = await new SupersessionStage().run(context());

    expect(requests).toHaveLength(0);
    expect(outcome.counts).toEqual({ supersessions: 0, supersessionProposals: 0 });
    expect(supersedesEdges()).toEqual(before);
  });

  it('re-running after a proposal leaves one proposal row', async () => {
    seedContradictingPair();
    responses = [
      { contradicts: true, confidence: 0.6, rationale: 'possibly' },
      { contradicts: true, confidence: 0.6, rationale: 'possibly' },
    ];

    await new SupersessionStage().run(context());
    await new SupersessionStage().run(context());

    expect(listSupersessionProposals(store.db)).toHaveLength(1);
  });
});

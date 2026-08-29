import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { coverageKey, narrativeNodeId } from '../domain/narrative.js';
import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { StageContext } from '../domain/stage.js';
import { NarrativeFakeGraph } from '../test-support/narrative-graph.fixture.js';
import {
  closeSessionNarrative,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  sweepIdleSessions,
  type NarrativeDeps,
} from './narratives.js';

const SESSION_ID = 'mcp-transport-session-1';
const OTHER_SESSION_ID = 'mcp-transport-session-2';
const EMBED_DIMENSION = 8;
const NOW = new Date('2026-04-02T12:00:00Z');

const FIRST_SENTENCE = 'The pair shipped the reflection worker.';
const SECOND_SENTENCE = 'They gated its re-run on the ledger key.';

const OUTPUT = {
  sentences: [
    { text: FIRST_SENTENCE, source_ids: ['S1'] },
    { text: SECOND_SENTENCE, source_ids: ['S2'] },
  ],
};

let graph: NarrativeFakeGraph;
let dataDir: string;
let logger: Logger;
let embed: ReturnType<typeof vi.fn>;
let generate: ReturnType<typeof vi.fn>;
let deps: NarrativeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map(() => Array.from({ length: EMBED_DIMENSION }, (_, slot) => 1 / (slot + 1)));
}

function seedEpisode(id: string, writtenAt: string, sessionId = SESSION_ID): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: `body of ${id}`,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [BITEMPORAL_PROPERTIES.occurredAt]: new Date(writtenAt),
    [BITEMPORAL_PROPERTIES.txFrom]: new Date(writtenAt),
  });
  graph.seedEdge(CONTAINMENT_TYPE, id, sessionId);
}

function seedDecision(id: string, episodeId: string, text: string): void {
  graph.seedNode(id, ['Decision', 'Memory', 'AionNode'], { [MEMORY_PROPERTIES.text]: text });
  graph.seedEdge('EXTRACTED_FROM', id, episodeId);
}

function narrativeNode(): { id: string; labels: readonly string[]; properties: Record<string, unknown> } {
  const node = graph.nodesWithLabel('Narrative')[0];
  expect(node).toBeDefined();
  return node as { id: string; labels: readonly string[]; properties: Record<string, unknown> };
}

function stageContext(now: Date): StageContext {
  const episode: EpisodeContext = {
    id: 'episode-1',
    sessionId: SESSION_ID,
    text: 'body of episode-1',
    turns: [],
  };
  return {
    driver: graph.driver,
    db: undefined as unknown as SqliteHandle,
    provider: deps.provider,
    episodeId: episode.id,
    episode,
    logger,
    now,
  };
}

beforeEach(() => {
  graph = new NarrativeFakeGraph();
  graph.seedNode(SESSION_ID, ['Session', 'AionNode']);
  graph.seedNode(OTHER_SESSION_ID, ['Session', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-narratives-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });

  embed = vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts)));
  generate = vi.fn(() => Promise.resolve(OUTPUT));
  deps = {
    driver: graph.driver,
    provider: { embed, generate } as unknown as Provider,
    logger,
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('session close', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    seedEpisode('episode-2', '2026-04-02T10:05:00Z');
  });

  it('compresses the session into a narrative with its provenance and vector', async () => {
    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('created');
    expect(result.version).toBe(1);
    expect(result.episodes).toBe(2);

    const node = narrativeNode();
    expect(node.id).toBe(narrativeNodeId(SESSION_ID, coverageKey(['episode-1', 'episode-2'])));
    expect(node.labels).toEqual(['Narrative', 'Memory', 'AionNode']);
    expect(node.properties[MEMORY_PROPERTIES.summary]).toBe(FIRST_SENTENCE);
    expect(node.properties[MEMORY_PROPERTIES.text]).toBe(FIRST_SENTENCE);
    expect(node.properties[NARRATIVE_PROPERTIES.citations]).toEqual(['episode-1']);
    expect(node.properties[NARRATIVE_PROPERTIES.sentenceCount]).toBe(1);
    expect(node.properties[NARRATIVE_PROPERTIES.scope]).toBe('session');
    expect(node.properties[NARRATIVE_PROPERTIES.version]).toBe(1);
    expect(node.properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(2);
    expect(node.properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
    expect(node.properties[MEMORY_PROPERTIES.contentVector]).toHaveLength(EMBED_DIMENSION);

    expect(
      graph.edgesOfType(SUMMARIZED_BY_TYPE).map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([
      ['episode-1', node.id],
      ['episode-2', node.id],
    ]);
    expect(graph.edgesOfType(DERIVES_FROM_TYPE).map((edge) => [edge.sourceId, edge.targetId])).toEqual(
      [[node.id, SESSION_ID]],
    );
  });

  it('embeds the narrative body, which is the property a later backfill would embed', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(embed).toHaveBeenCalledWith([FIRST_SENTENCE]);
  });

  it('sends the episodes to the model with reasoning off and a guard signal', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const request = generate.mock.calls[0]?.[0] as {
      model: string;
      think: boolean;
      signal: AbortSignal;
      maxTokens: number;
      messages: readonly { content: string }[];
    };
    expect(request.model).toBe('qwen3:8b');
    expect(request.think).toBe(false);
    expect(request.signal.aborted).toBe(false);
    expect(request.maxTokens).toBeLessThan(400);
    expect(request.messages[1]?.content).toContain('body of episode-2');
  });

  it('writes nothing on a re-close over the same episodes', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });
    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(second.status).toBe('skipped');
    expect(second.summary).toContain('already covers');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('skips a session that holds no episodes', async () => {
    const result = await closeSessionNarrative(deps, OTHER_SESSION_ID, { now: NOW });

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('no episodes');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('grounding', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    seedDecision('decision-1', 'episode-1', 'do not shard the orders table');
  });

  it('offers the decisions extracted from the session as citable sources', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const request = generate.mock.calls[0]?.[0] as { messages: readonly { content: string }[] };
    expect(request.messages[1]?.content).toContain('[S2] decision\ndo not shard the orders table');
  });

  it('stores the decision id when the sentence cited it', async () => {
    generate.mockResolvedValueOnce({
      sentences: [{ text: 'The orders table was left unsharded.', source_ids: ['S2'] }],
    });

    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(narrativeNode().properties[NARRATIVE_PROPERTIES.citations]).toEqual(['decision-1']);
  });

  it('keeps only the cited sentences of a mixed answer', async () => {
    generate.mockResolvedValueOnce({
      sentences: [
        { text: 'A service mesh was selected.', source_ids: [] },
        { text: 'The orders table was left unsharded.', source_ids: ['S2'] },
      ],
    });

    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const node = narrativeNode();
    expect(node.properties[MEMORY_PROPERTIES.text]).toBe('The orders table was left unsharded.');
    expect(node.properties[NARRATIVE_PROPERTIES.sentenceCount]).toBe(1);
  });
});

describe('regeneration', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('rewrites the standing narrative as a new version rather than in place', async () => {
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW, regenerate: true });

    expect(second.status).toBe('created');
    expect(second.version).toBe(2);
    expect(second.narrativeId).not.toBe(first.narrativeId);
    expect(graph.nodes.get(first.narrativeId as string)?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeDefined();
    expect(graph.edgesOfType('SUPERSEDES').map((edge) => [edge.sourceId, edge.targetId])).toEqual([
      [second.narrativeId, first.narrativeId],
    ]);
  });
});

describe('versioning', () => {
  it('mints version 2 and supersedes version 1 when the session grew', async () => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    seedEpisode('episode-2', '2026-04-02T10:05:00Z');
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    seedEpisode('episode-3', '2026-04-02T10:20:00Z');
    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(second.status).toBe('created');
    expect(second.version).toBe(2);
    expect(second.narrativeId).not.toBe(first.narrativeId);

    const closed = graph.nodes.get(first.narrativeId as string);
    expect(closed?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeDefined();
    expect(
      graph.edgesOfType('SUPERSEDES').map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([[second.narrativeId, first.narrativeId]]);

    const standing = graph
      .nodesWithLabel('Narrative')
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined);
    expect(standing).toHaveLength(1);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(3);
  });
});

describe('failure isolation', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('reports a compression failure without writing a half-formed narrative', async () => {
    generate.mockRejectedValueOnce(new Error('model timed out'));

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('model timed out');
    expect(graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('reports a malformed model answer as a failure rather than storing it', async () => {
    generate.mockResolvedValueOnce({ summary: 'only half of it' });

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('failed');
    expect(graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('stores nothing when no sentence cited a source the session holds', async () => {
    generate.mockResolvedValueOnce({
      sentences: [
        { text: 'The probe was gathering detailed data from a target.', source_ids: [] },
        { text: 'All relevant stakeholders were informed.', source_ids: ['S7'] },
      ],
    });

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('cited nothing');
    expect(graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('stores the narrative with its vector pending when the embedder is down', async () => {
    embed.mockRejectedValueOnce(new Error('ollama is down'));

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('created');
    expect(narrativeNode().properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
  });
});

describe('the reflection stage', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    seedEpisode('episode-2', '2026-04-02T10:05:00Z');
  });

  it('leaves a session that is still being written to alone', async () => {
    const outcome = await new SessionNarrativeStage().run(
      stageContext(new Date('2026-04-02T10:10:00Z')),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('the session is still active');
    expect(generate).not.toHaveBeenCalled();
  });

  it('compresses a session whose window has passed', async () => {
    const outcome = await new SessionNarrativeStage().run(stageContext(NOW));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ narratives: 1 });
    expect(graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('reports a failed compression as a stage failure rather than throwing', async () => {
    generate.mockRejectedValueOnce(new Error('model timed out'));

    const outcome = await new SessionNarrativeStage().run(stageContext(NOW));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('model timed out');
  });

  it('honours an idle window the caller set', async () => {
    const outcome = await new SessionNarrativeStage({ idleMs: 60_000 }).run(
      stageContext(new Date('2026-04-02T10:10:00Z')),
    );

    expect(outcome.status).toBe('ok');
  });
});

describe('idle sweep', () => {
  it('narrates the quiet session and leaves the busy one open', async () => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    seedEpisode('episode-2', '2026-04-02T11:55:00Z', OTHER_SESSION_ID);

    const results = await sweepIdleSessions(deps, { now: NOW });

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe(SESSION_ID);
    expect(results[0]?.status).toBe('created');
    expect(graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('stops offering a session whose narrative already covers it', async () => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await sweepIdleSessions(deps, { now: NOW });

    const second = await sweepIdleSessions(deps, { now: NOW });

    expect(second).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('the transport close hook', () => {
  beforeEach(() => {
    seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('narrates the closed session without the caller awaiting it', async () => {
    const closer = new SessionNarrativeCloser(deps);

    expect(closer.onSessionClosed(SESSION_ID)).toBeUndefined();
    await closer.whenIdle();

    expect(graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('swallows a failed close rather than taking teardown down with it', async () => {
    generate.mockRejectedValue(new Error('ollama is down'));
    const closer = new SessionNarrativeCloser(deps);

    closer.onSessionClosed(SESSION_ID);
    await expect(closer.whenIdle()).resolves.toBeUndefined();

    expect(graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('runs one close at a time, so a burst of disconnects does not fan out', async () => {
    let concurrent = 0;
    let peak = 0;
    generate.mockImplementation(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return OUTPUT;
    });
    graph.seedNode('session-3', ['Session', 'AionNode']);
    seedEpisode('episode-2', '2026-04-02T10:00:00Z', OTHER_SESSION_ID);
    seedEpisode('episode-3', '2026-04-02T10:00:00Z', 'session-3');

    const closer = new SessionNarrativeCloser(deps);
    closer.onSessionClosed(SESSION_ID);
    closer.onSessionClosed(OTHER_SESSION_ID);
    closer.onSessionClosed('session-3');
    await closer.whenIdle();

    expect(peak).toBe(1);
    expect(graph.nodesWithLabel('Narrative')).toHaveLength(3);
  });
});

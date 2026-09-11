import { beforeEach, describe, expect, it } from 'vitest';

import { closeSessionNarrative } from './narratives.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { coverageKey, narrativeNodeId } from '../domain/narrative.js';
import {
  deps,
  embed,
  EMBED_DIMENSION,
  FIRST_SENTENCE,
  generate,
  graph,
  NOW,
  OTHER_SESSION_ID,
  seedDecision,
  seedEpisode,
  SESSION_ID,
} from './test-support/legacy-regression.fixture.js';

async function narrativeNode(): Promise<{
  id: string;
  labels: readonly string[];
  properties: Record<string, unknown>;
}> {
  const node = (await graph.nodesWithLabel('Narrative'))[0];
  expect(node).toBeDefined();
  return node as { id: string; labels: readonly string[]; properties: Record<string, unknown> };
}

describe('session close', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedEpisode('episode-2', '2026-04-02T10:05:00Z');
  });

  it('compresses the session into a narrative with its provenance and vector', async () => {
    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('created');
    expect(result.version).toBe(1);
    expect(result.episodes).toBe(2);

    const node = await narrativeNode();
    expect(node.id).toBe(narrativeNodeId(SESSION_ID, coverageKey(['episode-1', 'episode-2'])));
    expect([...node.labels].sort()).toEqual(['AionNode', 'Memory', 'Narrative']);
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
      (await graph.edgesOfType(SUMMARIZED_BY_TYPE)).map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([
      ['episode-1', node.id],
      ['episode-2', node.id],
    ]);
    expect(
      (await graph.edgesOfType(DERIVES_FROM_TYPE)).map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([[node.id, SESSION_ID]]);
  });

  it('embeds the narrative body, which is the property a later backfill would embed', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(embed).toHaveBeenCalledWith([FIRST_SENTENCE]);
  });

  it('sends the episodes to the model unsampled, with reasoning off and a guard signal', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const request = generate.mock.calls[0]?.[0] as {
      model: string;
      temperature: number;
      think: boolean;
      signal: AbortSignal;
      maxTokens: number;
      messages: readonly { content: string }[];
    };
    expect(request.model).toBe('qwen3:8b');
    expect(request.temperature).toBe(0);
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
    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('skips a session that holds no episodes', async () => {
    const result = await closeSessionNarrative(deps, OTHER_SESSION_ID, { now: NOW });

    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('no episodes');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('grounding', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedDecision('decision-1', 'episode-1', 'do not shard the orders table');
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

    expect((await narrativeNode()).properties[NARRATIVE_PROPERTIES.citations]).toEqual([
      'decision-1',
    ]);
  });

  it('keeps only the cited sentences of a mixed answer', async () => {
    generate.mockResolvedValueOnce({
      sentences: [
        { text: 'A service mesh was selected.', source_ids: [] },
        { text: 'The orders table was left unsharded.', source_ids: ['S2'] },
      ],
    });

    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const node = await narrativeNode();
    expect(node.properties[MEMORY_PROPERTIES.text]).toBe('The orders table was left unsharded.');
    expect(node.properties[NARRATIVE_PROPERTIES.sentenceCount]).toBe(1);
  });
});

/**
 * A session longer than the window is read in consecutive chunks and the chunk texts are
 * compressed once more, so its opening reaches the narrative instead of being clipped off.
 * The window is pinned through the knob group the caller threads, which is the same seam a
 * deployment moves it with.
 */
describe('a session past the window', () => {
  const NARROW = { ...DEFAULTS.reflection, maxNarrativeEpisodes: 2 };
  const CHUNK_OPENING = 'The audit read the orders table.';
  const CHUNK_CLOSING = 'The backfill rewrote the amounts into cents.';
  const FINAL_SENTENCE = 'The session audited the ledger and cut it over.';

  /** Long enough that a chunk of two episodes supports a two-sentence answer. */
  function wordy(id: string): string {
    return `body of ${id}, ${'and the work went on. '.repeat(15)}`;
  }

  beforeEach(async () => {
    for (const [slot, stamp] of ['10:00', '10:05', '10:10', '10:15'].entries()) {
      const id = `episode-${String(slot + 1)}`;
      await seedEpisode(id, `2026-04-02T${stamp}:00Z`, SESSION_ID, wordy(id));
    }

    // Every chunk answer cites both of its items; the final answer, which is the one call
    // reading passages rather than episodes, cites the second chunk alone.
    generate.mockImplementation((request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      if (prompt.includes('] passage')) {
        return Promise.resolve({ sentences: [{ text: FINAL_SENTENCE, source_ids: ['S2'] }] });
      }
      return Promise.resolve({
        sentences: [
          { text: CHUNK_OPENING, source_ids: ['S1'] },
          { text: CHUNK_CLOSING, source_ids: ['S2'] },
        ],
      });
    });
  });

  it('reads a session inside the window in one call, over the episodes themselves', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]?.[0] as { messages: readonly { content: string }[] };
    expect(request.messages[1]?.content).toContain('[S1] episode');
    expect(request.messages[1]?.content).toContain('body of episode-1');
    expect((await narrativeNode()).properties[NARRATIVE_PROPERTIES.citations]).toEqual([
      'episode-1',
      'episode-2',
    ]);
  });

  it('synthesizes each chunk and then the chunk texts', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW, reflection: NARROW });

    expect(generate).toHaveBeenCalledTimes(3);
    const prompts = generate.mock.calls.map(
      (call) =>
        (call[0] as { messages: readonly { content: string }[] }).messages[1]?.content ?? '',
    );
    expect(prompts[0]).toContain('body of episode-1');
    expect(prompts[0]).not.toContain('body of episode-3');
    expect(prompts[1]).toContain('body of episode-3');
    expect(prompts[2]).toContain(`[S1] passage\n${CHUNK_OPENING} ${CHUNK_CLOSING}`);
    expect(prompts[2]).not.toContain('body of episode-1');
  });

  it('stores the episodes behind the chunk the final answer cited, and no others', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW, reflection: NARROW });

    const node = await narrativeNode();
    expect(node.properties[NARRATIVE_PROPERTIES.citations]).toEqual(['episode-3', 'episode-4']);
    expect(node.properties[MEMORY_PROPERTIES.text]).toBe(FINAL_SENTENCE);
  });

  it('records the whole session as covered, because every episode was read', async () => {
    await closeSessionNarrative(deps, SESSION_ID, { now: NOW, reflection: NARROW });

    const node = await narrativeNode();
    expect(node.properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(4);
    expect(node.properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
  });

  it('fails the whole attempt on a failed chunk rather than narrating part of it', async () => {
    generate.mockRejectedValueOnce(new Error('model timed out'));

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW, reflection: NARROW });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('model timed out');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
  });
});

describe('regeneration', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('rewrites the standing narrative as a new version rather than in place', async () => {
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW, regenerate: true });

    expect(second.status).toBe('created');
    expect(second.version).toBe(2);
    expect(second.narrativeId).not.toBe(first.narrativeId);
    expect(
      (await graph.node(first.narrativeId!))?.properties[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeDefined();
    expect(
      (await graph.edgesOfType('SUPERSEDES')).map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([[second.narrativeId, first.narrativeId]]);
  });
});

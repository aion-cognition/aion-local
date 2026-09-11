import { beforeEach, describe, expect, it } from 'vitest';

import {
  closeSessionNarrative,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  sweepIdleSessions,
} from './narratives.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { StageContext } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';
import {
  deps,
  embed,
  generate,
  graph,
  NOW,
  OTHER_SESSION_ID,
  OUTPUT,
  seedEpisode,
  seedSession,
  SESSION_ID,
  store,
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

function stageContext(now: Date): StageContext {
  const episode: EpisodeContext = {
    id: 'episode-1',
    sessionId: SESSION_ID,
    text: 'body of episode-1',
    turns: [],
  };
  return {
    driver: graph.driver,
    db: store.db,
    ...(deps.publications === undefined ? {} : { publications: deps.publications }),
    provider: deps.provider,
    episodeId: episode.id,
    episode,
    logger: deps.logger,
    now,
    occurredAt: episode.occurredAt ?? now,
    pipelineVersion: PIPELINE_VERSION,
  };
}

describe('versioning', () => {
  it('mints version 2 and supersedes version 1 when the session grew', async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedEpisode('episode-2', '2026-04-02T10:05:00Z');
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    await seedEpisode('episode-3', '2026-04-02T10:20:00Z');
    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(second.status).toBe('created');
    expect(second.version).toBe(2);
    expect(second.narrativeId).not.toBe(first.narrativeId);

    const closed = await graph.node(first.narrativeId!);
    expect(closed?.properties[BITEMPORAL_PROPERTIES.validUntil]).toBeDefined();
    expect(
      (await graph.edgesOfType('SUPERSEDES')).map((edge) => [edge.sourceId, edge.targetId]),
    ).toEqual([[second.narrativeId, first.narrativeId]]);

    const standing = (await graph.nodesWithLabel('Narrative')).filter(
      (node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined,
    );
    expect(standing).toHaveLength(1);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(3);
  });

  it('closes the summarization edges into the version it superseded, and no others', async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedEpisode('episode-2', '2026-04-02T10:05:00Z');
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    await seedEpisode('episode-3', '2026-04-02T10:20:00Z');
    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const edges = await graph.edgesOfType(SUMMARIZED_BY_TYPE);
    const closed = edges.filter((edge) => edge.targetId === first.narrativeId);
    const standing = edges.filter((edge) => edge.targetId === second.narrativeId);

    expect(closed).toHaveLength(2);
    expect(closed.every((edge) => edge.validUntil !== undefined)).toBe(true);
    expect(standing).toHaveLength(3);
    expect(standing.every((edge) => edge.validUntil === undefined)).toBe(true);
  });

  it('keeps the superseded version’s own provenance and lineage open', async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    const first = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    await seedEpisode('episode-2', '2026-04-02T10:20:00Z');
    const second = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    const derives = (await graph.edgesOfType(DERIVES_FROM_TYPE)).filter(
      (edge) => edge.sourceId === first.narrativeId,
    );
    expect(derives.map((edge) => edge.validUntil)).toEqual([undefined]);
    expect(
      (await graph.edgesOfType('SUPERSEDES'))
        .filter((edge) => edge.sourceId === second.narrativeId)
        .map((edge) => edge.validUntil),
    ).toEqual([undefined]);
  });
});

describe('failure isolation', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('reports a compression failure without writing a half-formed narrative', async () => {
    generate.mockRejectedValueOnce(new Error('model timed out'));

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('model timed out');
    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('reports a malformed model answer as a failure rather than storing it', async () => {
    generate.mockResolvedValueOnce({ summary: 'only half of it' });

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('failed');
    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
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
    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('stores the narrative with its vector pending when the embedder is down', async () => {
    embed.mockRejectedValueOnce(new Error('ollama is down'));

    const result = await closeSessionNarrative(deps, SESSION_ID, { now: NOW });

    expect(result.status).toBe('created');
    expect((await narrativeNode()).properties[MEMORY_PROPERTIES.contentVector]).toBeUndefined();
  });
});

describe('the reflection stage', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedEpisode('episode-2', '2026-04-02T10:05:00Z');
  });

  it('leaves a session that is still being written to alone', async () => {
    const outcome = await new SessionNarrativeStage().run(
      stageContext(new Date('2026-04-02T10:10:00Z')),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('the session is still active: 2 uncovered episodes and no pause');
    expect(generate).not.toHaveBeenCalled();
  });

  it('compresses a running session that paused long enough for the work to read as finished', async () => {
    await seedEpisode('episode-3', '2026-04-02T10:30:00Z');

    const outcome = await new SessionNarrativeStage().run(
      stageContext(new Date('2026-04-02T10:35:00Z')),
    );

    expect(outcome.status).toBe('ok');
    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(1);
    expect((await narrativeNode()).properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(3);
  });

  it('waits for the close instead once the mid-session boundary is switched off', async () => {
    await seedEpisode('episode-3', '2026-04-02T10:30:00Z');

    const outcome = await new SessionNarrativeStage({ midSession: false }).run(
      stageContext(new Date('2026-04-02T10:35:00Z')),
    );

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('the session is still active');
    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
  });

  it('compresses a session whose window has passed', async () => {
    const outcome = await new SessionNarrativeStage().run(stageContext(NOW));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ narratives: 1 });
    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(1);
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
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await seedEpisode('episode-2', '2026-04-02T11:55:00Z', OTHER_SESSION_ID);

    const results = await sweepIdleSessions(deps, { now: NOW });

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionId).toBe(SESSION_ID);
    expect(results[0]?.status).toBe('created');
    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('stops offering a session whose narrative already covers it', async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
    await sweepIdleSessions(deps, { now: NOW });

    const second = await sweepIdleSessions(deps, { now: NOW });

    expect(second).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('the transport close hook', () => {
  beforeEach(async () => {
    await seedEpisode('episode-1', '2026-04-02T10:00:00Z');
  });

  it('narrates the closed session without the caller awaiting it', async () => {
    const closer = new SessionNarrativeCloser(deps);

    // A void return, not a promise, is the guarantee under test: a caller that never awaits
    // this must never end up awaiting the narrative write it schedules.
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- see comment above
    expect(closer.onSessionClosed(SESSION_ID)).toBeUndefined();
    await closer.whenIdle();

    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(1);
  });

  it('swallows a failed close rather than taking teardown down with it', async () => {
    generate.mockRejectedValue(new Error('ollama is down'));
    const closer = new SessionNarrativeCloser(deps);

    closer.onSessionClosed(SESSION_ID);
    await expect(closer.whenIdle()).resolves.toBeUndefined();

    expect(await graph.nodesWithLabel('Narrative')).toEqual([]);
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
    await seedSession('session-3');
    await seedEpisode('episode-2', '2026-04-02T10:00:00Z', OTHER_SESSION_ID);
    await seedEpisode('episode-3', '2026-04-02T10:00:00Z', 'session-3');

    const closer = new SessionNarrativeCloser(deps);
    closer.onSessionClosed(SESSION_ID);
    closer.onSessionClosed(OTHER_SESSION_ID);
    closer.onSessionClosed('session-3');
    await closer.whenIdle();

    expect(peak).toBe(1);
    expect(await graph.nodesWithLabel('Narrative')).toHaveLength(3);
  });
});

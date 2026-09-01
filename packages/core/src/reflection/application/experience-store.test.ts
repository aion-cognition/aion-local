import type { Driver } from 'neo4j-driver';
import { beforeEach, describe, expect, it } from 'vitest';

import { ReflectionNotStoredError } from './errors.js';
import {
  storeExperience,
  type ExperienceStoreDeps,
  type StoredEpisode,
} from './experience-store.js';
import { LOCK_PROPERTY } from '../../infrastructure/graph/locks.js';
import { fromGraphDateTime } from '../../infrastructure/graph/values.js';
import { SessionManager } from '../../session/session-manager.js';
import { prepareEpisode, type ReflectionContent } from '../domain/content.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-1';

const PAYLOAD_CLOCK = new Date('2026-03-01T10:00:00.000Z');
const NOW = new Date('2026-08-14T09:30:00Z');

const CONTENT: ReflectionContent = {
  turns: [
    {
      role: 'user',
      text: 'why did the ingestion service pick webhooks',
      occurred_at: '2026-03-01T10:00:00Z',
    },
    {
      role: 'assistant',
      text: 'the vendor has no bulk export',
      occurred_at: '2026-03-01T10:00:05Z',
    },
  ],
  observations: ['webhooks were the only option the vendor offered'],
  summary: 'the webhook decision',
};

let graph: FakeGraph;
let deps: ExperienceStoreDeps;

beforeEach(() => {
  graph = new FakeGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode']);
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode']);

  deps = {
    driver: graph.driver,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
  };
});

function store(
  identity: string,
  content: ReflectionContent = CONTENT,
  origin?: Parameters<typeof storeExperience>[4],
): Promise<{ sessionId: string; stored: StoredEpisode }> {
  return storeExperience(deps, prepareEpisode(content, NOW), identity, NOW, origin);
}

describe('storing one experience', () => {
  it('writes the episode, its turns, and the backbone edges', async () => {
    const { sessionId, stored } = await store('session-a');

    expect(sessionId).toBe('session-a');
    expect(stored.created).toBe(true);

    const episode = graph.nodes.get(stored.episodeId);
    expect(episode?.labels).toEqual(['Episode', 'Memory', 'AionNode']);
    expect(episode?.properties).toMatchObject({
      summary: CONTENT.summary,
      session_id: 'session-a',
      turn_count: 2,
      tool_execution_count: 0,
      observation_count: 1,
      extraction_method: 'reflection_intake',
    });

    const turns = graph.nodesWithLabel('Turn');
    expect(turns.map((turn) => turn.properties.sequence)).toEqual([0, 1]);
    expect(turns.map((turn) => turn.properties.role)).toEqual(['user', 'assistant']);
    expect(turns.every((turn) => turn.properties.source_episode_id === stored.episodeId)).toBe(
      true,
    );

    const containment = graph.edgesOfType('PARTICIPATES_IN');
    expect(containment).toHaveLength(3);
    expect(
      containment.some((edge) => edge.sourceId === stored.episodeId && edge.targetId === sessionId),
    ).toBe(true);

    const chained = graph.edgesOfType('FOLLOWS').filter((edge) => edge.sourceId === turns[1]?.id);
    expect(chained.map((edge) => edge.targetId)).toEqual([turns[0]?.id]);
  });

  it('stamps world time from the payload and transaction time from the caller clock', async () => {
    const { stored } = await store('session-a');

    const episode = graph.nodes.get(stored.episodeId);
    expect(fromGraphDateTime(episode?.properties.occurred_at)).toEqual(PAYLOAD_CLOCK);
    expect(fromGraphDateTime(episode?.properties.valid_from)).toEqual(PAYLOAD_CLOCK);
    expect(fromGraphDateTime(episode?.properties.tx_from)).toEqual(NOW);
  });

  it('takes the session lock before it writes the episode', async () => {
    const { sessionId } = await store('session-a');

    const locked = graph.statements.findIndex(
      (statement) =>
        statement.cypher.includes(`SET n.${LOCK_PROPERTY}`) &&
        statement.parameters.id === sessionId,
    );
    const written = graph.statements.findIndex((statement) =>
      statement.cypher.startsWith('MERGE (n:Episode'),
    );

    expect(locked).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(locked);
  });

  it('reports the episode and every turn as awaiting a vector', async () => {
    const { stored } = await store('session-a');

    const turns = graph.nodesWithLabel('Turn');
    expect(stored.pending.map((node) => node.id)).toEqual([
      stored.episodeId,
      ...turns.map((turn) => turn.id),
    ]);
    expect(stored.pending.map((node) => node.text)).toContain(CONTENT.turns?.[0]?.text);
  });

  it('stores the origin channel and event when the caller names one', async () => {
    const { stored } = await store('session-a', CONTENT, { channel: 'hook', event: 'stop' });

    expect(graph.nodes.get(stored.episodeId)?.properties).toMatchObject({
      origin_channel: 'hook',
      origin_event: 'stop',
    });
  });

  it('writes no origin property at all when the caller names none', async () => {
    const { stored } = await store('session-a');

    const episode = graph.nodes.get(stored.episodeId);
    expect(episode?.properties.origin_channel).toBeUndefined();
    expect(episode?.properties.origin_event).toBeUndefined();
  });
});

describe('storing an experience the session already holds', () => {
  it('returns the stored episode and opens no write transaction', async () => {
    const first = await store('session-a');
    const statementsAfterFirst = graph.statements.length;
    const lockedAfterFirst = [...graph.locked];

    const repeat = await store('session-a');

    expect(repeat.stored).toEqual({
      episodeId: first.stored.episodeId,
      created: false,
      pending: [],
    });
    expect(graph.nodesWithLabel('Episode')).toHaveLength(1);
    expect(graph.nodesWithLabel('Turn')).toHaveLength(2);
    expect(graph.locked).toEqual(lockedAfterFirst);
    // One read to find the episode already stored, and nothing else.
    expect(graph.statements.length).toBe(statementsAfterFirst + 1);
  });

  // The dedupe window is the session, so the same content under a second identity is a
  // second experience: two agents saying the same thing had two conversations.
  it('stores the same content again under a second identity', async () => {
    const first = await store('session-a');
    const second = await store('session-b');

    expect(second.stored.episodeId).not.toBe(first.stored.episodeId);
    expect(second.stored.created).toBe(true);
    expect(graph.nodesWithLabel('Episode')).toHaveLength(2);
  });
});

/** A driver whose every call fails the way an unreachable server does, code and all. */
function unavailableDriver(): Driver {
  const fail = (): never => {
    const err = new Error('connection refused') as Error & { code: string };
    err.code = 'ServiceUnavailable';
    throw err;
  };
  return { executeQuery: fail, session: fail } as unknown as Driver;
}

/** A driver whose calls fail the way a rejected statement does: an answer, not an outage. */
function rejectingDriver(): Driver {
  const fail = (): never => {
    const err = new Error('Unknown relationship type') as Error & { code: string };
    err.code = 'Neo.ClientError.Statement.SyntaxError';
    throw err;
  };
  return { executeQuery: fail, session: fail } as unknown as Driver;
}

describe('storing an experience the graph cannot take', () => {
  function depsOn(driver: Driver): ExperienceStoreDeps {
    return {
      driver,
      sessions: new SessionManager(driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    };
  }

  it('tells the caller nothing was stored when the graph is unreachable', async () => {
    deps = depsOn(unavailableDriver());

    await expect(store('session-a')).rejects.toThrow(ReflectionNotStoredError);
    await expect(store('session-a')).rejects.toThrow(/graph is unavailable/);
  });

  // A statement the server answered and refused is a defect in this code, and dressing it as
  // an outage would tell the caller to retry a call that will fail the same way forever.
  it('lets a statement the graph rejected through unchanged', async () => {
    deps = depsOn(rejectingDriver());

    await expect(store('session-a')).rejects.toThrow(/Unknown relationship type/);
    await expect(store('session-a')).rejects.not.toBeInstanceOf(ReflectionNotStoredError);
  });
});

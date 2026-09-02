import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CueCache } from './cues.js';
import { readModeFor } from './read-mode.js';
import { handleRecall, type RecallCompletion, type RecallDeps } from './recall.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { buildAdjacencyStatement } from '../../infrastructure/graph/adjacency.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { FakeGraph } from '../../reflection/test-support/fake-graph.fixture.js';
import { SessionManager } from '../../session/session-manager.js';

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-global';
const IDENTITY = 'mcp-transport-session-1';
const NOW = new Date('2026-08-27T12:00:00.000Z');

const NO_CHANGES = { nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 };

/**
 * The cold-start substrate: session writes behave, and every recall read answers with nothing
 * because there is nothing stored. `FakeGraph` throws on a statement it does not model, which
 * is what keeps this honest: only the read shapes it has no model for fall through to the
 * empty answer.
 */
class EmptySubstrateGraph extends FakeGraph {
  /** Flipped mid-test to model the server going away under a process that is already warm. */
  offline = false;

  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.offline) {
      throw new Error('ServiceUnavailable: connect ECONNREFUSED');
    }
    try {
      return await super.executeQuery(cypher, parameters);
    } catch {
      return { records: [], summary: { counters: { updates: () => NO_CHANGES } } };
    }
  }
}

let dir: string;
let store: SqliteStore;
let logger: Logger;
let graph: EmptySubstrateGraph;
let embed: ReturnType<typeof vi.fn>;
let generate: ReturnType<typeof vi.fn>;

function provider(): Provider {
  return { embed, generate } as unknown as Provider;
}

function deps(overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    driver: graph.driver,
    db: store.db,
    sessions: new SessionManager(graph.driver, {
      memberId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
    }),
    provider: provider(),
    config: DEFAULTS,
    cueCache: new CueCache(),
    logger,
    ...overrides,
  };
}

function statementsMatching(fragment: string): number {
  return graph.statements.filter((statement) => statement.cypher.includes(fragment)).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-recall-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  graph = new EmptySubstrateGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode'], { name: 'Ryan Huber' });
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode'], { name: 'global' });

  embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0, 0]));
  generate = vi.fn(async () => ({
    query_cues: ['webhook ingestion'],
    summary_cues: [],
    recent_turn_cues: [],
  }));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('read mode', () => {
  const ANNOTATING = { now: NOW, expiryAnnotation: true };

  /**
   * One recall issues ten or more fragments. Without the run's own clock on the mode, each
   * one reads the wall clock for itself, and a reading sitting on its horizon comes back
   * current on one leg and expired on the next.
   */
  it('defaults to currency-aware, judged from the run own clock', () => {
    expect(readModeFor({ query: 'why webhooks' }, ANNOTATING)).toEqual({ reference: NOW });
  });

  it('threads as_of and knew_at through as world time and system time', () => {
    expect(readModeFor({ query: 'q', as_of: '2026-03-01' }, ANNOTATING)).toEqual({
      validAt: new Date('2026-03-01'),
    });
    expect(readModeFor({ query: 'q', knew_at: '2026-03-01' }, ANNOTATING)).toEqual({
      knownAt: new Date('2026-03-01'),
    });
    expect(
      readModeFor({ query: 'q', as_of: '2026-03-01', knew_at: '2026-04-01' }, ANNOTATING),
    ).toEqual({
      validAt: new Date('2026-03-01'),
      knownAt: new Date('2026-04-01'),
    });
  });

  it('carries the expiry kill switch onto the mode every fragment is built from', () => {
    const off = { now: NOW, expiryAnnotation: false };
    expect(readModeFor({ query: 'q' }, off)).toEqual({ reference: NOW, expiryAnnotation: false });
    expect(readModeFor({ query: 'q', as_of: '2026-03-01' }, off)).toEqual({
      validAt: new Date('2026-03-01'),
      expiryAnnotation: false,
    });
  });
});

describe('recall against an empty substrate', () => {
  it('returns an explicitly empty pack instead of padding it', async () => {
    const pack = await handleRecall(
      deps(),
      { query: 'why did we pick webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.facts).toBeUndefined();
    expect(pack.episodes).toBeUndefined();
    expect(pack.narratives).toBeUndefined();
    expect(pack.preferences).toBeUndefined();
    expect(pack.resonant).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
    // The caller's own question leads the cue set whatever the model returned.
    expect(pack.metadata.cues).toEqual([
      { text: 'why did we pick webhooks', source: 'query', weight: 3 },
      { text: 'webhook ingestion', source: 'query', weight: 3 },
    ]);
  });

  it('skips activation when no strategy found a seed', async () => {
    await handleRecall(deps(), { query: 'why webhooks' }, { identity: IDENTITY, now: NOW });

    const adjacency = buildAdjacencyStatement({
      frontier: ['any'],
      visited: [],
      mode: withCurrency(),
      minStrength: DEFAULTS.recall.associationStrength,
      topK: DEFAULTS.recall.adjacencyTopK,
    });
    expect(statementsMatching(adjacency.cypher.split('\n')[0] ?? '')).toBe(0);
  });

  it('spends exactly one generate call and one embed call', async () => {
    await handleRecall(deps(), { query: 'why webhooks' }, { identity: IDENTITY, now: NOW });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
    // Every cue reaches the embedder in the spelling `embed-models.ts` names for the configured
    // model, which is raw for every model in the table today.
    expect(embed).toHaveBeenCalledWith(['why webhooks', 'webhook ingestion']);
  });

  it('records a timing for every stage, and they account for the call rather than exceed it', async () => {
    const started = performance.now();
    const pack = await handleRecall(
      deps(),
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );
    const elapsed = performance.now() - started;

    const timings = pack.metadata.stage_timings_ms;
    for (const stage of ['cues', 'embed', 'seeds', 'activation', 'fusion'] as const) {
      expect(timings[stage]).toBeGreaterThanOrEqual(0);
    }
    // The stages run one after another inside the call, so their sum is bounded by the call. A
    // stamp reported in place of a span, or one stage's clock counted into another's, breaks
    // that; `>= 0` holds for either.
    const spent = Object.values(timings).reduce((total, ms) => total + ms, 0);
    expect(spent).toBeLessThanOrEqual(elapsed);
  });
});

describe('session identity and persistence', () => {
  it('persists the pack it served under the transport session', async () => {
    const pack = await handleRecall(
      deps(),
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    const saved = getLastPack(store.db, IDENTITY);
    expect(saved?.pack).toEqual(pack);
    expect(saved?.ts).toBe(NOW.toISOString());
  });

  it('lets session_id in the payload override the transport identity', async () => {
    await handleRecall(
      deps(),
      { query: 'why webhooks', session_id: 'caller-owned-session' },
      { identity: IDENTITY, now: NOW },
    );

    expect(getLastPack(store.db, 'caller-owned-session')).toBeDefined();
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
  });
});

describe('degradation', () => {
  it('answers on the raw query and names the ladder when the cue model fails', async () => {
    generate.mockRejectedValueOnce(new Error('ollama is down'));

    const pack = await handleRecall(
      deps(),
      { query: 'why did we pick webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.metadata.degraded).toEqual([{ stage: 'cues', reason: 'model_error' }]);
    expect(pack.metadata.cues).toEqual([
      { text: 'why did we pick webhooks', source: 'raw_query', weight: 3 },
    ]);
    expect(embed).toHaveBeenCalledWith(['why did we pick webhooks']);
  });

  it('still serves a pack when embedding is unavailable, and says the vector leg is gone', async () => {
    embed.mockRejectedValueOnce(new Error('ollama is down'));

    const pack = await handleRecall(
      deps(),
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.metadata.degraded).toEqual([{ stage: 'embed', reason: 'model_error' }]);
    expect(pack.metadata.cues).toHaveLength(2);
    expect(pack.rendered_text).toContain('No memories matched this query.');
    expect(pack.rendered_text).toContain('note: degraded embedding (model_error)');
  });

  // The ladder's deeper rung. Both inference calls are gone, and a pack that named only the
  // cue rung would read as "vectors are fine, the cue model broke".
  it('names both inference rungs when the whole model host is gone', async () => {
    generate.mockRejectedValueOnce(new Error('fetch failed'));
    embed.mockRejectedValueOnce(new Error('fetch failed'));

    const pack = await handleRecall(
      deps(),
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.metadata.degraded).toEqual([
      { stage: 'cues', reason: 'model_error' },
      { stage: 'embed', reason: 'model_error' },
    ]);
  });

  /**
   * The failure this closes: with the graph gone, every seed leg is isolated into silence
   * and the caller is handed an empty pack that is byte-identical to a genuine miss. The
   * session resolves from the manager's cache, which is what keeps recall answering at all.
   */
  it('names the graph rung rather than reporting an outage as an empty substrate', async () => {
    const shared = deps();
    await handleRecall(shared, { query: 'why webhooks' }, { identity: IDENTITY, now: NOW });

    graph.offline = true;
    const pack = await handleRecall(
      shared,
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.metadata.degraded).toEqual([{ stage: 'graph', reason: 'unavailable' }]);
    expect(pack.rendered_text).toContain('No memories matched this query.');
  });

  it('leaves the marker absent when the substrate is simply empty', async () => {
    const pack = await handleRecall(
      deps(),
      { query: 'why webhooks' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );

    expect(pack.metadata.degraded).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
  });
});

describe('the side-effect seam', () => {
  it('hands the listener the served pack off the response path', async () => {
    const seen: RecallCompletion[] = [];
    const pack = await handleRecall(
      deps({
        onRecalled: (completion) => {
          seen.push(completion);
        },
      }),
      { query: 'why webhooks' },
      { identity: IDENTITY, now: NOW },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.pack).toEqual(pack);
    expect(seen[0]?.sessionId).toBe(IDENTITY);
    expect(seen[0]?.activated).toEqual([]);
  });

  it('serves the pack even when the listener throws', async () => {
    const pack = await handleRecall(
      deps({
        onRecalled: () => {
          throw new Error('reinforcement enqueue failed');
        },
      }),
      { query: 'why webhooks' },
      { identity: IDENTITY, now: NOW },
    );

    expect(pack.metadata.cues).toHaveLength(2);
  });
});

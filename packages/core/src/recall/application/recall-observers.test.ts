import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { FakeGraph } from '../../reflection/test-support/fake-graph.fixture.js';
import { SessionManager } from '../../session/session-manager.js';
import { emittedWithinCandidates, type RecallTrace } from '../domain/recall-trace.js';

/**
 * The diagnostic observer has to be free: a run with one and a run without one must reach the
 * same pack through the same calls, or a comparison between two traced runs is measuring the
 * tracing.
 */

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-global';
const IDENTITY = 'mcp-transport-session-1';
const NOW = new Date('2026-08-27T12:00:00.000Z');
const QUERY = 'why did we pick webhooks';

const NO_CHANGES = { nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 };

/** Answers every read shape it has no model for with nothing, the way a cold substrate does. */
class EmptySubstrateGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
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

function deps(overrides: Partial<RecallDeps> = {}): RecallDeps {
  return {
    driver: graph.driver,
    db: store.db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider: { embed, generate } as unknown as Provider,
    config: DEFAULTS,
    cueCache: new CueCache(),
    logger,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-recall-trace-'));
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

describe('recall with a trace observer attached', () => {
  it('reaches the same pack through the same calls as a run without one', async () => {
    // One warm-up first: the population reading is cached per driver for half a minute, so the
    // very first run of a process issues a query the ones after it do not.
    await handleRecall(deps(), { query: QUERY }, { identity: IDENTITY, now: NOW });
    graph.statements.length = 0;
    generate.mockClear();
    embed.mockClear();

    const untraced = await handleRecall(deps(), { query: QUERY }, { identity: IDENTITY, now: NOW });
    const baseline = {
      statements: graph.statements.length,
      generate: generate.mock.calls.length,
      embed: embed.mock.calls.length,
    };

    graph.statements.length = 0;
    generate.mockClear();
    embed.mockClear();

    const traces: RecallTrace[] = [];
    const traced = await handleRecall(
      deps({ onTrace: (trace) => traces.push(trace) }),
      { query: QUERY },
      { identity: IDENTITY, now: NOW },
    );

    // Stage timings are wall-clock and never repeat; everything else the pack holds must.
    expect({ ...traced, metadata: { ...traced.metadata, stage_timings_ms: undefined } }).toEqual({
      ...untraced,
      metadata: { ...untraced.metadata, stage_timings_ms: undefined },
    });
    expect(graph.statements.length).toBe(baseline.statements);
    expect(generate.mock.calls.length).toBe(baseline.generate);
    expect(embed.mock.calls.length).toBe(baseline.embed);
    expect(traces).toHaveLength(1);
  });

  it('records the resolved session and the run identity as digests', async () => {
    const traces: RecallTrace[] = [];
    await handleRecall(
      deps({ onTrace: (trace) => traces.push(trace) }),
      { query: QUERY },
      { identity: IDENTITY, now: NOW },
    );

    const [trace] = traces;
    const resolved = new SessionManager(graph.driver, {
      memberId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
    }).sessionIdFor(IDENTITY);
    expect(trace?.sessionId).toBe(resolved);
    expect(trace?.sampledAt).toBe(NOW.toISOString());
    expect(trace?.readMode).toBe('default');
    expect(trace?.queryDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(trace)).not.toContain('webhooks');
  });

  it('names the vantage a time-traveled read bound the run to', async () => {
    const traces: RecallTrace[] = [];
    await handleRecall(
      deps({ onTrace: (trace) => traces.push(trace) }),
      { query: QUERY, as_of: '2026-03-01' },
      { identity: IDENTITY, now: NOW },
    );
    expect(traces[0]?.readMode).toBe('as_of');
  });

  it('reports every seed leg, including the ones that found nothing', async () => {
    const traces: RecallTrace[] = [];
    await handleRecall(
      deps({ onTrace: (trace) => traces.push(trace) }),
      { query: QUERY },
      { identity: IDENTITY, now: NOW },
    );
    expect(traces[0]?.seedLegs.map((leg) => leg.strategy).sort()).toEqual([
      'bm25',
      'context_vector',
      'entity_resolution',
      'recency',
      'vector',
    ]);
  });

  it('keeps what the pack printed inside what assembly was offered', async () => {
    const traces: RecallTrace[] = [];
    await handleRecall(
      deps({ onTrace: (trace) => traces.push(trace) }),
      { query: QUERY },
      { identity: IDENTITY, now: NOW },
    );
    const [trace] = traces;
    expect(trace === undefined ? false : emittedWithinCandidates(trace)).toBe(true);
  });

  it('runs the pack listener and the trace independently of each other', async () => {
    const listened: string[] = [];
    const traces: RecallTrace[] = [];
    await handleRecall(
      deps({
        onRecalled: (completion) => listened.push(completion.sessionId),
        onTrace: (trace) => traces.push(trace),
      }),
      { query: QUERY },
      { identity: IDENTITY, now: NOW },
    );
    expect(listened).toHaveLength(1);
    expect(traces[0]?.sessionId).toBe(listened[0]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import type {
  ReflectionStage,
  ReflectionSummary,
  StageContext,
  StageOutcome,
} from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';
import { orchestratorLedgerKey, type ReflectionOrchestratorDeps } from '../orchestrator.js';

/**
 * One seeded episode and the stage doubles every orchestrator unit case runs against.
 *
 * Split out of `orchestrator.test.ts` when that file crossed the standing line cap. Nothing here
 * asserts: what a run does with an ordinary stage list and what it does with a stage that fails
 * are two files now, and both read the same substrate from this one.
 */

export const EPISODE_ID = 'episode-1';
export const SESSION_ID = 'session-1';
export const OCCURRED_AT = new Date('2026-08-28T09:00:00.000Z');
export const NOW = new Date('2026-08-28T09:05:00.000Z');

export let graph: FakeGraph;
export let store: SqliteStore;
let dataDir: string;
export let deps: ReflectionOrchestratorDeps;
/** Every stage the run entered, in order, so isolation can be asserted by what still ran. */
export let entered: string[];
export let contexts: StageContext[];

export const provider: Provider = {
  embed: async () => [],
  generate: async () => ({}),
};

function seedEpisode(): void {
  graph.seedNode(SESSION_ID, ['Session', 'AionNode']);
  graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: 'user: ship the worker\nassistant: shipping it',
    [MEMORY_PROPERTIES.summary]: 'shipping the worker',
    [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
    [BITEMPORAL_PROPERTIES.occurredAt]: OCCURRED_AT,
  });
  graph.seedEdge(CONTAINMENT_TYPE, EPISODE_ID, SESSION_ID);

  // Seeded out of order on purpose: the loader, not the writer, is what puts turns in sequence.
  for (const turn of [
    { id: 'turn-1', role: 'assistant', sequence: 1, text: 'shipping it' },
    { id: 'turn-0', role: 'user', sequence: 0, text: 'ship the worker' },
  ]) {
    graph.seedNode(turn.id, ['Turn', 'Memory', 'AionNode'], {
      [MEMORY_PROPERTIES.role]: turn.role,
      [MEMORY_PROPERTIES.sequence]: turn.sequence,
      [MEMORY_PROPERTIES.text]: turn.text,
      [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
      [BITEMPORAL_PROPERTIES.occurredAt]: OCCURRED_AT,
    });
    graph.seedEdge(CONTAINMENT_TYPE, turn.id, EPISODE_ID);
  }
}

export function stage(name: string, outcome: StageOutcome): ReflectionStage {
  return {
    name,
    run: async (ctx: StageContext): Promise<StageOutcome> => {
      entered.push(name);
      contexts.push(ctx);
      return outcome;
    },
  };
}

export function poisoned(name: string, message: string): ReflectionStage {
  return {
    name,
    run: async (ctx: StageContext): Promise<StageOutcome> => {
      entered.push(name);
      contexts.push(ctx);
      throw new Error(message);
    },
  };
}

export function ledgerSummary(): ReflectionSummary | undefined {
  return getLedgerEntry(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))?.summary as
    ReflectionSummary | undefined;
}

/** How many times the run read the episode, which is what "loaded once" is measured by. */
export function episodeReads(): number {
  return graph.statements.filter((statement) =>
    statement.cypher.includes('MATCH (e:Episode { id: $episodeId })'),
  ).length;
}

beforeEach(() => {
  graph = new FakeGraph();
  seedEpisode();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-orchestrator-'));
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  entered = [];
  contexts = [];
  deps = {
    driver: graph.driver,
    db: store.db,
    provider,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
  };
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

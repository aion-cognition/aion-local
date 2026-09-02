import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  orchestratorLedgerKey,
  ReflectionOrchestrator,
  type ReflectionOrchestratorDeps,
} from './orchestrator.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type {
  ReflectionStage,
  ReflectionSummary,
  StageContext,
  StageOutcome,
} from '../domain/stage.js';
import { stageLedgerKey } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';
import { FakeGraph } from '../test-support/fake-graph.fixture.js';

const EPISODE_ID = 'episode-1';
const SESSION_ID = 'session-1';
const OCCURRED_AT = new Date('2026-08-28T09:00:00.000Z');
const NOW = new Date('2026-08-28T09:05:00.000Z');

let graph: FakeGraph;
let store: SqliteStore;
let dataDir: string;
let deps: ReflectionOrchestratorDeps;
/** Every stage the run entered, in order, so isolation can be asserted by what still ran. */
let entered: string[];
let contexts: StageContext[];

const provider: Provider = {
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

function stage(name: string, outcome: StageOutcome): ReflectionStage {
  return {
    name,
    run: async (ctx: StageContext): Promise<StageOutcome> => {
      entered.push(name);
      contexts.push(ctx);
      return outcome;
    },
  };
}

function poisoned(name: string, message: string): ReflectionStage {
  return {
    name,
    run: async (ctx: StageContext): Promise<StageOutcome> => {
      entered.push(name);
      contexts.push(ctx);
      throw new Error(message);
    },
  };
}

function ledgerSummary(): ReflectionSummary | undefined {
  return getLedgerEntry(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))?.summary as
    ReflectionSummary | undefined;
}

/** How many times the run read the episode, which is what "loaded once" is measured by. */
function episodeReads(): number {
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

describe('ReflectionOrchestrator', () => {
  it('runs the stages in the order they were registered and records each outcome', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
      stage('dedup', { status: 'ok', summary: 'merged 1 duplicate', counts: { merges: 1 } }),
      stage('narrative', { status: 'skipped', summary: 'session still open' }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(orchestrator.stageNames).toEqual(['entities', 'dedup', 'narrative']);
    expect(entered).toEqual(['entities', 'dedup', 'narrative']);
    expect(run.status).toBe('completed');
    expect(run.applied).toBe(true);
    expect(run.summary.episodeId).toBe(EPISODE_ID);
    expect(run.summary.counts).toEqual({ entities: 2, merges: 1 });
    expect(run.summary.stages.map((entry) => [entry.name, entry.status, entry.summary])).toEqual([
      ['entities', 'ok', 'extracted 2 entities'],
      ['dedup', 'ok', 'merged 1 duplicate'],
      ['narrative', 'skipped', 'session still open'],
    ]);
    for (const entry of run.summary.stages) {
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.error).toBeUndefined();
    }
  });

  it('records the enrichment summary under the orchestrator ledger key', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID)).toBe(
      `reflection:orchestrator:${PIPELINE_VERSION}:${EPISODE_ID}`,
    );
    expect(ledgerSummary()).toEqual(run.summary);
  });

  it('loads the episode once and hands the same context to every stage', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('first', { status: 'ok', summary: 'ok' }),
      stage('second', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(episodeReads()).toBe(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);

    const context = contexts[0]!;
    expect(context.episodeId).toBe(EPISODE_ID);
    expect(context.now).toBe(NOW);
    expect(context.provider).toBe(provider);
    expect(context.db).toBe(store.db);
    expect(context.episode.sessionId).toBe(SESSION_ID);
    expect(context.episode.summary).toBe('shipping the worker');
    expect(context.episode.occurredAt).toEqual(OCCURRED_AT);
    expect(context.episode.turns.map((turn) => [turn.sequence, turn.role, turn.text])).toEqual([
      [0, 'user', 'ship the worker'],
      [1, 'assistant', 'shipping it'],
    ]);
  });

  it('enriches once across two runs: the ledger gate skips the second', async () => {
    const stages = [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
    ];

    const first = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    const second = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('already_applied');
    expect(second.applied).toBe(false);
    expect(second.summary.stages).toEqual([]);
    expect(second.summary.counts).toEqual({});
    expect(entered).toEqual(['entities']);
    // The gate costs one SQLite read: the skipped run never reaches the graph.
    expect(episodeReads()).toBe(1);
    expect(ledgerSummary()).toEqual(first.summary);
  });

  it('re-enters an episode a later pipeline version has not enriched, stage by stage', async () => {
    const stages = [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
      stage('cognitive', { status: 'ok', summary: 'extracted 1 decision' }),
    ];

    const first = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    const bumped = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, {
      now: NOW,
      pipelineVersion: 'v2',
    });

    expect(first.applied).toBe(true);
    expect(bumped.status).toBe('completed');
    expect(bumped.applied).toBe(true);
    expect(bumped.summary.skippedStages).toEqual([]);
    expect(entered).toEqual(['entities', 'cognitive', 'entities', 'cognitive']);

    // Both forks stand: what the old version enriched is still recorded as enriched under it.
    for (const version of [PIPELINE_VERSION, 'v2']) {
      expect(isLedgerApplied(store.db, orchestratorLedgerKey(version, EPISODE_ID))).toBe(true);
      expect(isLedgerApplied(store.db, stageLedgerKey(version, 'entities', EPISODE_ID))).toBe(true);
      expect(isLedgerApplied(store.db, stageLedgerKey(version, 'cognitive', EPISODE_ID))).toBe(
        true,
      );
    }
  });

  it('stamps the context with the version the run was asked for', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW, pipelineVersion: 'v7' });

    expect(contexts[0]?.pipelineVersion).toBe('v7');
  });

  it('defaults the context to the shipped pipeline version', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(contexts[0]?.pipelineVersion).toBe(PIPELINE_VERSION);
  });

  it("stamps the context's world time from the episode, not from the run's clock", async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(contexts[0]?.occurredAt).toEqual(OCCURRED_AT);
    expect(contexts[0]?.now).toBe(NOW);
  });

  it("falls back to the run's clock for an episode carrying no world time", async () => {
    graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode'], {
      [MEMORY_PROPERTIES.text]: 'user: ship the worker',
      [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
    });
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(contexts[0]?.occurredAt).toBe(NOW);
  });

  it('isolates a stage that throws: the rest of the pipeline still runs', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } }),
      poisoned('cognitive', 'the model returned nonsense'),
      stage('associations', {
        status: 'ok',
        summary: 'linked 3 pairs',
        counts: { associations: 3 },
      }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(entered).toEqual(['entities', 'cognitive', 'associations']);
    expect(run.status).toBe('completed');
    expect(run.summary.counts).toEqual({ entities: 2, associations: 3 });

    const failure = run.summary.stages[1];
    expect(failure?.name).toBe('cognitive');
    expect(failure?.status).toBe('failed');
    expect(failure?.error).toBe('the model returned nonsense');

    // Isolation is about the run, not the gate: the stages after the throw did their work,
    // and the episode stays retryable so the one that threw gets another attempt.
    expect(run.applied).toBe(false);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      false,
    );
  });

  it('records a stage that reports failure without throwing, and keeps its explanation', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('cognitive', { status: 'failed', summary: 'the circuit breaker is open' }),
      stage('associations', { status: 'ok', summary: 'linked 3 pairs' }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(run.summary.stages[0]?.summary).toBe('the circuit breaker is open');
    expect(run.summary.stages[0]?.error).toBeUndefined();
    expect(run.applied).toBe(false);
  });

  it('leaves the ledger unmarked when every stage failed, so the job retries', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      poisoned('entities', 'ollama is down'),
      stage('cognitive', { status: 'failed', summary: 'nothing to extract from' }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(run.status).toBe('completed');
    expect(run.applied).toBe(false);
    expect(run.summary.stages.map((entry) => entry.status)).toEqual(['failed', 'failed']);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      false,
    );
    // The all-failed rule holds at both levels: neither stage's own key is set either.
    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'entities', EPISODE_ID)),
    ).toBe(false);
    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'cognitive', EPISODE_ID)),
    ).toBe(false);
  });

  it('re-enters a stage that skipped for want of what the failed stage before it owed', async () => {
    let extractionAttempts = 0;
    let enrichCalls = 0;
    const extraction: ReflectionStage = {
      name: 'entities',
      run: async () => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) {
          throw new Error('the reflect model timed out');
        }
        return { status: 'ok' as const, summary: 'extracted 2 entities', counts: { entities: 2 } };
      },
    };
    // Reads what extraction writes, so its skip is the failure above it and not a decision of
    // its own: the retry that re-extracts owes this stage its run too.
    const enrich: ReflectionStage = {
      name: 'associations',
      run: async () => {
        enrichCalls += 1;
        return extractionAttempts > 1
          ? { status: 'ok' as const, summary: 'inferred 1 association' }
          : {
              status: 'skipped' as const,
              summary: 'no entities mentioned in the episode',
              retryable: true,
            };
      },
    };
    const stages = [extraction, enrich];

    const first = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    expect(first.applied).toBe(false);
    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'associations', EPISODE_ID)),
    ).toBe(false);

    const second = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });

    expect(enrichCalls).toBe(2);
    expect(second.summary.skippedStages).toEqual([]);
    expect(second.summary.stages.map((entry) => entry.status)).toEqual(['ok', 'ok']);
    expect(second.applied).toBe(true);
  });

  it('re-enters only the stages that have not yet applied across three retries, and never twice a stage that has', async () => {
    let entityCalls = 0;
    let narrativeCalls = 0;
    let semanticAttempts = 0;
    const entities: ReflectionStage = {
      name: 'entities',
      run: async () => {
        entityCalls += 1;
        return { status: 'ok', summary: 'extracted 2 entities', counts: { entities: 2 } };
      },
    };
    // A stage that decides for itself there is nothing to do is just as terminal as `ok`:
    // its ledger key closes too, so it does not re-run on the retries that follow it either.
    const narrative: ReflectionStage = {
      name: 'narrative',
      run: async () => {
        narrativeCalls += 1;
        return { status: 'skipped', summary: 'session still open' };
      },
    };
    const semanticRelationships: ReflectionStage = {
      name: 'semantic-relationships',
      run: async () => {
        semanticAttempts += 1;
        if (semanticAttempts < 3) {
          throw new Error('semantic relationship call timed out: AbortError');
        }
        return { status: 'ok', summary: 'extracted 4 relationships', counts: { cognitive: 4 } };
      },
    };
    const stages = [entities, narrative, semanticRelationships];

    const first = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    const second = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    const third = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });

    // The node-minting stages ran exactly once each, no matter how many retries the failing
    // stage cost the run; that bound is what makes re-minting impossible.
    expect(entityCalls).toBe(1);
    expect(narrativeCalls).toBe(1);
    expect(semanticAttempts).toBe(3);

    expect(first.applied).toBe(false);
    expect(second.applied).toBe(false);
    expect(third.applied).toBe(true);

    expect(second.summary.skippedStages).toEqual(['entities', 'narrative']);
    expect(third.summary.skippedStages).toEqual(['entities', 'narrative']);
    expect(third.summary.counts).toEqual({ cognitive: 4 });

    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'entities', EPISODE_ID)),
    ).toBe(true);
    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'narrative', EPISODE_ID)),
    ).toBe(true);
    expect(
      isLedgerApplied(
        store.db,
        stageLedgerKey(PIPELINE_VERSION, 'semantic-relationships', EPISODE_ID),
      ),
    ).toBe(true);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      true,
    );
  });

  it('gives a transiently failed stage another attempt: the second run skips the stage that already applied', async () => {
    // `cognitive` succeeded on attempt one, so the per-stage ledger closes it out and the
    // retry re-enters only `entities`, the stage that actually has something left to do.
    let attempts = 0;
    const flaky = {
      name: 'entities',
      run: async () => {
        entered.push('entities');
        attempts += 1;
        if (attempts === 1) {
          throw new Error('the reflect model timed out');
        }
        return { status: 'ok' as const, summary: 'extracted 2 entities', counts: { entities: 2 } };
      },
    };
    const stages = [flaky, stage('cognitive', { status: 'ok', summary: 'extracted 1 decision' })];

    const first = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });
    const second = await new ReflectionOrchestrator(deps, stages).run(EPISODE_ID, { now: NOW });

    expect(first.applied).toBe(false);
    expect(second.status).toBe('completed');
    expect(second.applied).toBe(true);
    expect(second.summary.counts).toEqual({ entities: 2 });
    expect(second.summary.skippedStages).toEqual(['cognitive']);
    expect(entered).toEqual(['entities', 'cognitive', 'entities']);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      true,
    );
    expect(
      isLedgerApplied(store.db, stageLedgerKey(PIPELINE_VERSION, 'cognitive', EPISODE_ID)),
    ).toBe(true);
  });

  it('leaves the ledger unmarked when no stages are registered', async () => {
    const run = await new ReflectionOrchestrator(deps, []).run(EPISODE_ID, { now: NOW });

    expect(run.status).toBe('completed');
    expect(run.applied).toBe(false);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      false,
    );
  });

  it('runs no stage and marks nothing when the episode is not readable', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities' }),
    ]);

    const run = await orchestrator.run('episode-that-never-existed', { now: NOW });

    expect(run.status).toBe('episode_unavailable');
    expect(run.applied).toBe(false);
    expect(entered).toEqual([]);
    expect(
      isLedgerApplied(
        store.db,
        orchestratorLedgerKey(PIPELINE_VERSION, 'episode-that-never-existed'),
      ),
    ).toBe(false);
  });

  it('treats a forgotten episode as unreadable', async () => {
    graph.seedNode(EPISODE_ID, ['Episode', 'Memory', 'AionNode'], {
      [MEMORY_PROPERTIES.text]: 'user: ship the worker',
      [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
      [BITEMPORAL_PROPERTIES.forgottenAt]: NOW,
    });
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('entities', { status: 'ok', summary: 'extracted 2 entities' }),
    ]);

    const run = await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(run.status).toBe('episode_unavailable');
    expect(entered).toEqual([]);
  });

  it('propagates an outage rather than reporting it as a run, so the caller retries', async () => {
    const failing = {
      executeQuery: async (): Promise<never> => {
        throw new Error('ServiceUnavailable');
      },
    };
    const orchestrator = new ReflectionOrchestrator(
      { ...deps, driver: failing as unknown as ReflectionOrchestratorDeps['driver'] },
      [stage('entities', { status: 'ok', summary: 'extracted 2 entities' })],
    );

    await expect(orchestrator.run(EPISODE_ID, { now: NOW })).rejects.toThrow('ServiceUnavailable');
    expect(entered).toEqual([]);
    expect(isLedgerApplied(store.db, orchestratorLedgerKey(PIPELINE_VERSION, EPISODE_ID))).toBe(
      false,
    );
  });

  it('does not see a later change to the stage list it was constructed with', async () => {
    const stages: ReflectionStage[] = [stage('entities', { status: 'ok', summary: 'ok' })];
    const orchestrator = new ReflectionOrchestrator(deps, stages);
    stages.push(stage('smuggled', { status: 'ok', summary: 'ok' }));

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(entered).toEqual(['entities']);
  });
});

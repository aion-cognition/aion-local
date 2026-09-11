import { describe, expect, it } from 'vitest';

import {
  orchestratorLedgerKey,
  ReflectionOrchestrator,
  type ReflectionOrchestratorDeps,
} from './orchestrator.js';
import {
  deps,
  entered,
  EPISODE_ID,
  graph,
  NOW,
  poisoned,
  SESSION_ID,
  stage,
  store,
} from './test-support/orchestrator-unit.fixture.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { ReflectionStage } from '../domain/stage.js';
import { stageLedgerKey } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * What a run does when a stage does not finish: one throwing stage isolated from the rest, the
 * retry gate that re-enters only what has not applied, and the reads that never run at all.
 */
describe('ReflectionOrchestrator under stage failure and retry', () => {
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

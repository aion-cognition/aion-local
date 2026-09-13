import { describe, expect, it } from 'vitest';

import { orchestratorLedgerKey, ReflectionOrchestrator } from './orchestrator.js';
import {
  contexts,
  deps,
  entered,
  episodeReads,
  EPISODE_ID,
  graph,
  ledgerSummary,
  NOW,
  OCCURRED_AT,
  provider,
  SESSION_ID,
  stage,
  store,
} from './test-support/orchestrator-unit.fixture.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { stageLedgerKey } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

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
    // The entry is the run's summary and the binding it was produced under: an outcome recorded
    // without saying which generation's obligations it settled cannot be reused safely.
    expect(ledgerSummary()).toEqual({
      ...run.summary,
      binding: { processingGeneration: 0, operationalRevision: 0, work: {} },
    });
  });

  it('loads the episode once and hands the same context to every stage', async () => {
    const orchestrator = new ReflectionOrchestrator(deps, [
      stage('first', { status: 'ok', summary: 'ok' }),
      stage('second', { status: 'ok', summary: 'ok' }),
    ]);

    await orchestrator.run(EPISODE_ID, { now: NOW });

    expect(episodeReads()).toBe(1);
    expect(contexts).toHaveLength(2);
    // One reading of the episode, shared whole. The provider is the one field that is per stage:
    // each gets a watcher over the same backend, so a refusal one stage was given is recorded
    // against that stage rather than against whichever ran next.
    expect(contexts[0]?.episode).toBe(contexts[1]?.episode);
    expect(contexts[0]?.provider).not.toBe(contexts[1]?.provider);

    const context = contexts[0]!;
    expect(context.episodeId).toBe(EPISODE_ID);
    expect(context.now).toBe(NOW);
    expect(context.provider.route).toBe(provider.route);
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
    // The skipped run answers with what the key recorded rather than with nothing: those are
    // the outcomes the settlement needs when the first run's completion never landed. Timings
    // and counts belong to the run that took them and do not travel.
    expect(second.summary.stages).toEqual([
      { name: 'entities', status: 'ok', summary: 'extracted 2 entities', durationMs: 0 },
    ]);
    expect(second.summary.counts).toEqual({});
    expect(entered).toEqual(['entities']);
    // The gate costs one SQLite read: the skipped run never reaches the graph.
    expect(episodeReads()).toBe(1);
    expect(ledgerSummary()).toEqual({
      ...first.summary,
      binding: { processingGeneration: 0, operationalRevision: 0, work: {} },
    });
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
});

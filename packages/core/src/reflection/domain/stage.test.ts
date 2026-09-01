import { describe, expect, it } from 'vitest';

import {
  mergeStageCounts,
  shouldMarkApplied,
  stageAlreadyAppliedRecord,
  stageLedgerKey,
  STAGE_ALREADY_APPLIED_SUMMARY,
  summarizeRun,
  type StageRecord,
} from './stage.js';

function record(
  name: string,
  status: StageRecord['status'],
  counts?: Record<string, number>,
): StageRecord {
  return {
    name,
    status,
    summary: `${name} ${status}`,
    durationMs: 1,
    ...(counts === undefined ? {} : { counts }),
  };
}

describe('mergeStageCounts', () => {
  it('sums the same key across stages and keeps the rest', () => {
    const counts = mergeStageCounts([
      record('entities', 'ok', { entities: 3, mentions: 3 }),
      record('dedup', 'ok', { entities: 1, merges: 2 }),
      record('associations', 'ok', { associations: 5 }),
    ]);

    expect(counts).toEqual({ entities: 4, mentions: 3, merges: 2, associations: 5 });
  });

  it('counts a failed stage that still reported partial work', () => {
    const counts = mergeStageCounts([
      record('entities', 'failed', { entities: 2 }),
      record('dedup', 'skipped'),
    ]);

    expect(counts).toEqual({ entities: 2 });
  });

  it('is empty for stages that reported no counts', () => {
    expect(mergeStageCounts([record('narrative', 'skipped')])).toEqual({});
    expect(mergeStageCounts([])).toEqual({});
  });
});

describe('shouldMarkApplied', () => {
  it('marks a run where no stage failed', () => {
    expect(shouldMarkApplied([record('a', 'ok'), record('b', 'ok')])).toBe(true);
    expect(shouldMarkApplied([record('a', 'ok'), record('b', 'skipped')])).toBe(true);
    expect(shouldMarkApplied([record('a', 'skipped'), record('b', 'skipped')])).toBe(true);
  });

  it('leaves a run with one failed stage retryable, whatever the rest did', () => {
    expect(shouldMarkApplied([record('a', 'failed'), record('b', 'ok')])).toBe(false);
    expect(shouldMarkApplied([record('a', 'ok'), record('b', 'failed')])).toBe(false);
  });

  it('leaves the model-outage shape retryable: generation fails, everything downstream skips', () => {
    expect(
      shouldMarkApplied([
        record('entities', 'failed'),
        record('entity-dedup', 'skipped'),
        record('associations', 'skipped'),
        record('cognitive', 'failed'),
        record('semantic-relationships', 'skipped'),
        record('supersession', 'skipped'),
        record('reinforcement', 'skipped'),
        record('context-vectors', 'ok'),
      ]),
    ).toBe(false);
  });

  it('leaves a run whose every stage failed retryable', () => {
    expect(shouldMarkApplied([record('a', 'failed'), record('b', 'failed')])).toBe(false);
  });

  it('leaves an unconfigured pipeline retryable', () => {
    expect(shouldMarkApplied([])).toBe(false);
  });
});

describe('summarizeRun', () => {
  it('carries the episode, the duration, every stage, and the merged counts', () => {
    const stages = [
      record('entities', 'ok', { entities: 2 }),
      record('dedup', 'ok', { merges: 1 }),
    ];
    const summary = summarizeRun('episode-1', 42.5, stages);

    expect(summary).toEqual({
      episodeId: 'episode-1',
      durationMs: 42.5,
      stages,
      counts: { entities: 2, merges: 1 },
      skippedStages: [],
    });
  });

  it('survives JSON round-tripping, which is how the ledger stores it', () => {
    const summary = summarizeRun('episode-1', 3, [record('entities', 'ok', { entities: 1 })]);

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('names the stages the per-stage ledger skipped, apart from a stage that skipped on its own', () => {
    const summary = summarizeRun('episode-1', 3, [
      stageAlreadyAppliedRecord('entities'),
      record('narrative', 'skipped'),
      record('cognitive', 'ok', { cognitive: 4 }),
    ]);

    expect(summary.skippedStages).toEqual(['entities']);
  });
});

describe('stageLedgerKey', () => {
  it('follows the pinned per-stage format', () => {
    expect(stageLedgerKey('v1', 'cognitive', 'episode-1')).toBe(
      'reflection:stage:v1:cognitive:episode-1',
    );
  });

  it('gives one stage of one episode a key per pipeline version', () => {
    expect(stageLedgerKey('v2', 'cognitive', 'episode-1')).not.toBe(
      stageLedgerKey('v1', 'cognitive', 'episode-1'),
    );
  });
});

describe('stageAlreadyAppliedRecord', () => {
  it('is a skipped record carrying the already-applied sentinel and no duration', () => {
    expect(stageAlreadyAppliedRecord('entities')).toEqual({
      name: 'entities',
      status: 'skipped',
      summary: STAGE_ALREADY_APPLIED_SUMMARY,
      durationMs: 0,
    });
  });
});

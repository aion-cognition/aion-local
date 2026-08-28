import { describe, expect, it } from 'vitest';
import {
  mergeStageCounts,
  shouldMarkApplied,
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
  it('marks a run where any stage did not fail', () => {
    expect(shouldMarkApplied([record('a', 'failed'), record('b', 'ok')])).toBe(true);
    expect(shouldMarkApplied([record('a', 'failed'), record('b', 'skipped')])).toBe(true);
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
    const stages = [record('entities', 'ok', { entities: 2 }), record('dedup', 'ok', { merges: 1 })];
    const summary = summarizeRun('episode-1', 42.5, stages);

    expect(summary).toEqual({
      episodeId: 'episode-1',
      durationMs: 42.5,
      stages,
      counts: { entities: 2, merges: 1 },
    });
  });

  it('survives JSON round-tripping, which is how the ledger stores it', () => {
    const summary = summarizeRun('episode-1', 3, [record('entities', 'ok', { entities: 1 })]);

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});

import { describe, expect, it } from 'vitest';
import type { ReflectionRun } from './orchestrator.js';
import { describeFailedRun } from './worker.js';

describe('describeFailedRun', () => {
  function run(
    stages: ReflectionRun['summary']['stages'],
    skipped: readonly string[] = [],
  ): ReflectionRun {
    return {
      episodeId: 'ep-1',
      status: 'completed',
      applied: false,
      summary: { episodeId: 'ep-1', durationMs: 1, stages, counts: {}, skippedStages: skipped },
    };
  }

  /**
   * The message an operator reads off the queue row. "no stage enriched" was false the first
   * time it was measured, with eight of nine stages applied and one timed out, and the
   * per-stage ledger makes it further from true, since a retry re-enters only what failed.
   */
  it('names the stage that failed and how much was already applied', () => {
    const message = describeFailedRun(
      'ep-1',
      run(
        [
          { name: 'entities', status: 'ok', summary: 'applied', durationMs: 4, counts: {} },
          {
            name: 'semantic-relationships',
            status: 'failed',
            summary: 'call timed out',
            error: 'semantic relationship call timed out: AbortError',
            durationMs: 60_000,
            counts: {},
          },
        ],
        ['entities', 'cognitive', 'associations'],
      ),
    );

    expect(message).toContain('semantic-relationships');
    expect(message).toContain('AbortError');
    expect(message).toContain('3 stages already applied');
    expect(message).not.toContain('no stage enriched');
  });

  it('keeps the old message for the run that genuinely enriched nothing', () => {
    expect(describeFailedRun('ep-1', run([]))).toBe('no stage enriched ep-1');
  });
});

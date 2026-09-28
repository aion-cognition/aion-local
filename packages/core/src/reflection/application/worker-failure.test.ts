import { describe, expect, it } from 'vitest';

import type { ReflectionRun } from './orchestrator.js';
import { describeFailedRun } from './worker.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';

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

  it('reports withheld judgments without claiming successful extraction produced nothing', () => {
    const message = describeFailedRun(
      'ep-1',
      run(
        [
          { name: 'cognitive', status: 'ok', summary: 'extracted claims', durationMs: 1 },
          {
            name: 'supersession',
            status: 'skipped',
            summary: 'judgment withheld',
            durationMs: 1,
            retryable: true,
            withheldWork: [
              {
                nodeIds: ['claim-a', 'claim-b'],
                disposition: 'retryable',
                reason: 'budget_limit',
                addresses: [],
                revision: buildEvidenceRevision([]),
              },
            ],
          },
        ],
        ['entities'],
      ),
    );

    expect(message).toBe(
      'reflection incomplete for ep-1 (1 stages already applied): supersession: budget_limit',
    );
  });
});

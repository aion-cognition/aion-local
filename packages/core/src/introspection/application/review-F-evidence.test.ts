import { expect, it } from 'vitest';
import { openSqliteHandle } from '../../infrastructure/sqlite/database.js';
import { appendBridgeTraversalEvent } from '../../infrastructure/sqlite/sense-usage-events.js';
import {
  appendModelLesson,
  recentModelLessons,
} from '../../infrastructure/sqlite/introspection-model-lessons.js';
import { appendApiCall } from '../../infrastructure/sqlite/api-usage.js';
import { summarizeBridgeTraversal } from './senses/bridge-traversal-sense.js';
import {
  summarizeCompatibilityCalibration,
  describeCompatibilityCalibration,
} from '../domain/compatibility-calibration.js';
import { summarizeCoOccursDensity } from '../domain/co-occurs-density.js';
import {
  buildBatchCadenceReport,
  describeBatchCadenceReport,
} from './reports/batch-cadence-report.js';

const NOW = new Date('2026-09-13T12:00:00Z');
it('lets new observations enter a bounded sense after its first page fills', () => {
  const db = openSqliteHandle({ filePath: ':memory:' });
  try {
    for (let n = 0; n < 3; n += 1) {
      appendBridgeTraversalEvent(db, {
        sessionId: 's',
        bridgeId: `b${String(n)}`,
        legs: n === 2 ? ['into', 'out'] : ['into'],
        crossed: n === 2,
        emitted: false,
        occurredAt: new Date(NOW.getTime() + n),
      });
    }
    const summary = summarizeBridgeTraversal(db, 2);
    console.log(JSON.stringify({ case: 'frozen-observation-prefix', summary }));
    expect(summary.recordsScanned).toBeLessThanOrEqual(2);
    expect(summary.bridgesCrossed).toBe(1);
  } finally {
    db.close();
  }
});
it('preserves the association between compatibility and traversal in model evidence', () => {
  const bridges = [0.2, 0.9].map((compatibility, n) => ({
    id: `b${String(n)}`,
    author: 'model' as const,
    compatibility,
    createdAt: NOW,
  }));
  const low = describeCompatibilityCalibration(
    summarizeCompatibilityCalibration(bridges, [{ bridgeId: 'b0', crossed: true }], NOW),
  );
  const high = describeCompatibilityCalibration(
    summarizeCompatibilityCalibration(bridges, [{ bridgeId: 'b1', crossed: true }], NOW),
  );
  console.log(JSON.stringify({ case: 'lost-compatibility-association', low, high }));
  expect(low).not.toEqual(high);
});
it('keeps a recoverable basis for a model-authored lesson', () => {
  const db = openSqliteHandle({ filePath: ':memory:' });
  const basis = 'bridge b731 had one observed leg contribution in observation window 41-47';
  try {
    appendModelLesson(db, {
      cycle: 7,
      operation: 'none',
      lesson: 'One leg is not an end-to-end crossing.',
      reason: 'idle',
      senseEvidence: [basis],
    });
    const rows = db.prepare('SELECT * FROM introspection_model_lessons').all();
    expect(recentModelLessons(db, 10)).toHaveLength(1);
    console.log(JSON.stringify({ case: 'unresolvable-lesson-basis', rows }));
    // A hash alone cannot recover which observations the model read.
    expect(JSON.stringify(rows)).toContain(basis);
  } finally {
    db.close();
  }
});
it('does not count recurring-only updates as additional birth-strength observations', () => {
  const first = {
    pairsProposed: 1,
    pairsWritten: 1,
    births: 1,
    recurrences: 0,
    birthStrength: 0.8,
  };
  const again = {
    pairsProposed: 10,
    pairsWritten: 10,
    births: 0,
    recurrences: 10,
    birthStrength: 0.1,
  };
  const summary = summarizeCoOccursDensity([first, again, again], []);
  console.log(JSON.stringify({ case: 'recurrences-as-births', summary }));
  expect(summary.birthStrengths).toEqual([0.8]);
});
for (const [inputTokens, cacheReadTokens, percent] of [
  [10, 90, '90.0'],
  [0, 100, '100.0'],
] as const) {
  it(`uses all input classes as the cache-share denominator: ${percent}`, () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    try {
      appendApiCall(db, {
        occurredAt: NOW,
        model: 'claude-haiku-4-5',
        surface: 'review',
        inputTokens,
        cacheReadTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 1,
        attempts: 1,
      });
      const lines = describeBatchCadenceReport(
        buildBatchCadenceReport(db, NOW, new Date(NOW.getTime() + 1)),
      );
      console.log(JSON.stringify({ case: 'cache-share', lines }));
      expect(lines.join(' ')).toContain(`(${percent}% served from cache)`);
    } finally {
      db.close();
    }
  });
}

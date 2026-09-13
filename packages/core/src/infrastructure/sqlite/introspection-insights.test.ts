import { beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  appendIntrospectionInsight,
  INSIGHT_RETENTION_ROWS,
  listRecentInsights,
} from './introspection-insights.js';

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

describe('introspection insights', () => {
  it('reads the newest lessons back oldest first, in the order they happened', () => {
    for (const depth of [9, 4, 1]) {
      appendIntrospectionInsight(store.db, {
        operation: 'dead_letter',
        lesson: `left the queue at ${String(depth)}`,
      });
    }

    expect(listRecentInsights(store.db, 2).map((insight) => insight.lesson)).toEqual([
      'left the queue at 4',
      'left the queue at 1',
    ]);
  });

  it('answers nothing on a substrate that has resolved no run', () => {
    expect(listRecentInsights(store.db, 8)).toEqual([]);
  });

  it('takes a limit of zero as a caller asking for none', () => {
    appendIntrospectionInsight(store.db, { operation: 'memory_decay', lesson: 'ran' });

    expect(listRecentInsights(store.db, 0)).toEqual([]);
  });

  /** A window, not an archive: the ledger is where a run's full record lives. */
  it('keeps the table bounded as runs accumulate', () => {
    for (let index = 0; index < INSIGHT_RETENTION_ROWS + 25; index += 1) {
      appendIntrospectionInsight(store.db, {
        operation: 'memory_decay',
        lesson: `run ${String(index)}`,
      });
    }

    const rows = store.db.prepare('SELECT count(*) AS n FROM introspection_insights').get() as {
      n: number;
    };
    expect(rows.n).toBe(INSIGHT_RETENTION_ROWS);
    expect(listRecentInsights(store.db, 1)[0]?.lesson).toBe(
      `run ${String(INSIGHT_RETENTION_ROWS + 24)}`,
    );
  });
});

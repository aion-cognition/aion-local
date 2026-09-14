import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { gatherTier3Evidence } from './tier3-evidence.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { appendIntrospectionInsight } from '../../infrastructure/sqlite/introspection-insights.js';

const NOW = new Date('2026-09-14T00:00:00.000Z');
const LOGGER = openLogger({ filePath: '/dev/null', level: 'error' });

/** A graph that refuses every read, standing in for a substrate a sense's driver call cannot reach. */
function throwingDriver(): Driver {
  return {
    executeQuery: () => Promise.reject(new Error('the graph is unreachable')),
  } as unknown as Driver;
}

function workingDriver(): Driver {
  return {
    executeQuery: () =>
      Promise.resolve({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      }),
  } as unknown as Driver;
}

describe('gatherTier3Evidence with an absent or throwing sense', () => {
  it('returns clean evidence, never throws, when every graph-backed sense fails', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });
    appendIntrospectionInsight(db, {
      operation: 'dead_letter',
      lesson: 'ran and cleared the backlog',
    });

    const evidence = await gatherTier3Evidence(
      { driver: throwingDriver(), db, config: DEFAULTS, logger: LOGGER },
      NOW,
    );

    // The deterministic ledger is untouched by a graph failure: insights still reads fine.
    expect(evidence.insights).toHaveLength(1);
    expect(evidence.insights[0]).toContain('ran and cleared the backlog');
    // The graph-backed senses (judgment durability, compatibility calibration) came back empty
    // rather than throwing; the sqlite-only senses (bridge traversal, resonance usefulness,
    // co-occurs density) still ran, and none of it stopped the read from completing.
    expect(evidence.senseEvidence).toEqual([]);
    expect(evidence.lessons).toEqual([]);
    db.close();
  });

  it('reports an empty population, not an error, when nothing has been observed yet', async () => {
    const db = openSqliteHandle({ filePath: ':memory:' });

    const evidence = await gatherTier3Evidence(
      { driver: workingDriver(), db, config: DEFAULTS, logger: LOGGER },
      NOW,
    );

    expect(evidence.insights).toEqual([]);
    expect(evidence.lessons).toEqual([]);
    // Judgment durability states an empty population explicitly rather than staying silent;
    // every other sense (sqlite-only, and compatibility calibration over an empty bridge list)
    // has nothing to say yet.
    expect(evidence.senseEvidence).toEqual([
      'judgment durability: no supersession lineage recorded yet',
      '0 reversal(s) observed directly in the stream ' +
        '(no judgment transition record in the stream yet).',
    ]);
    db.close();
  });

  it('a closed sqlite handle fails every section, and gatherTier3Evidence still returns cleanly', async () => {
    const db: SqliteHandle = openSqliteHandle({ filePath: ':memory:' });
    db.close();

    // The proof this test exists for: a handle that throws on every query must not make
    // gatherTier3Evidence reject. If it did, engine.ts's #consultTier3 would never reach the
    // advisor at all, and a broken collector would have taken the whole cycle down with it.
    await expect(
      gatherTier3Evidence({ driver: workingDriver(), db, config: DEFAULTS, logger: LOGGER }, NOW),
    ).resolves.toEqual({ insights: [], senseEvidence: [], lessons: [] });
  });
});

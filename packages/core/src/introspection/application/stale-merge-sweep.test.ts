import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { staleMergeLedgerKey, sweepStaleMergeProposals } from './stale-merge-sweep.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getEntityMergeProposal,
  recordEntityMergeProposal,
  resolveEntityMergeProposal,
} from '../../infrastructure/sqlite/entity-merge-proposals.js';
import { getLedgerEntry } from '../../infrastructure/sqlite/ops-ledger.js';

/**
 * The fake models the one read the sweep issues, the currency check, and throws on anything
 * else so a query shape change fails loudly rather than being answered by a double that does
 * not model it. The predicate itself is proven against a real Neo4j in
 * `proposal-hygiene.int.test.ts`.
 */
function fakeDriver(current: ReadonlySet<string>): Driver {
  const executeQuery = (cypher: string, parameters: Record<string, unknown>): Promise<unknown> => {
    if (!cypher.includes('n IS NULL')) {
      throw new Error(`stale merge sweep fake driver does not model this query: ${cypher}`);
    }
    const ids = (parameters.ids as string[] | undefined) ?? [];
    const records = ids
      .filter((id) => !current.has(id))
      .sort()
      .map((id) => ({ toObject: () => ({ id }) }));
    return Promise.resolve({ records });
  };
  return { executeQuery } as unknown as Driver;
}

const NOW = new Date('2026-09-01T14:00:00.000Z');

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-stale-merge-sweep-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM entity_merge_proposals');
  db.exec('DELETE FROM ops_ledger');
});

function propose(left: string, right: string, episodeId = 'ep-1'): string {
  return recordEntityMergeProposal(db, {
    subject: { id: left, name: left, type: 'tool' },
    candidate: { id: right, name: right, type: 'topic' },
    similarity: 0.9,
    episodeId,
    createdAt: NOW.toISOString(),
  });
}

function sweep(current: ReadonlySet<string>): ReturnType<typeof sweepStaleMergeProposals> {
  return sweepStaleMergeProposals({ db, driver: fakeDriver(current), logger, now: NOW });
}

describe('stale merge proposal sweep', () => {
  it('resolves a row whose side lost currency, with no horizon to wait for', async () => {
    const id = propose('left-1', 'right-1');

    const result = await sweep(new Set(['left-1']));

    expect(result).toEqual({ examined: 1, resolved: 1 });
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
  });

  it('leaves a row both of whose sides still hold currency', async () => {
    const id = propose('left-2', 'right-2');

    const result = await sweep(new Set(['left-2', 'right-2']));

    expect(result).toEqual({ examined: 1, resolved: 0 });
    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBeNull();
  });

  it('resolves a row pointing at an id the graph does not know', async () => {
    const id = propose('left-3', 'right-3');

    await sweep(new Set());

    expect(getEntityMergeProposal(db, id)?.resolvedAt).toBe(NOW.toISOString());
  });

  it('records which sides went, so the resolution is a note and not a silent close', async () => {
    const id = propose('left-4', 'right-4', 'ep-4');

    await sweep(new Set(['right-4']));

    expect(getLedgerEntry(db, staleMergeLedgerKey(id))?.summary).toEqual({
      reason: 'a side of this pair lost currency, so there is nothing left to merge',
      goneSides: ['left-4'],
      leftId: 'left-4',
      leftName: 'left-4',
      rightId: 'right-4',
      rightName: 'right-4',
      episodeId: 'ep-4',
    });
  });

  it('reads no graph and resolves nothing when every row is already resolved', async () => {
    const id = propose('left-5', 'right-5');
    resolveEntityMergeProposal(db, id, NOW.toISOString());

    const result = await sweepStaleMergeProposals({
      db,
      driver: {
        executeQuery: () => {
          throw new Error('the sweep must not read the graph with no open row to check');
        },
      } as unknown as Driver,
      logger,
      now: NOW,
    });

    expect(result).toEqual({ examined: 0, resolved: 0 });
  });

  it('bounds one run, so a queue that has gone stale wholesale drains over ticks', async () => {
    for (let index = 0; index < 5; index += 1) {
      propose(`bulk-left-${String(index)}`, `bulk-right-${String(index)}`);
    }

    const result = await sweepStaleMergeProposals({
      db,
      driver: fakeDriver(new Set()),
      logger,
      now: NOW,
      limit: 3,
    });

    expect(result).toEqual({ examined: 3, resolved: 3 });
  });

  it('stamps nothing when another resolver got there first', async () => {
    const id = propose('left-6', 'right-6');
    // Open when the sweep lists it, resolved before the sweep writes: the same race the
    // hygiene dismissal already reports rather than double-counts.
    const running = sweepStaleMergeProposals({
      db,
      driver: fakeDriver(new Set()),
      logger,
      now: NOW,
    });
    resolveEntityMergeProposal(db, id, '2026-08-20T00:00:00.000Z');

    expect(await running).toEqual({ examined: 1, resolved: 0 });
    expect(getLedgerEntry(db, staleMergeLedgerKey(id))).toBeUndefined();
  });
});

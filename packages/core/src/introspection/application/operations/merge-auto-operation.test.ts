import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mergeAutoOperation, mergeAutoRelevance } from './merge-auto-operation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { recordEntityMergeProposal } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * A disabled knob and a fuzzy-only queue never reach `applyEntityMergeProposal`, so both cases
 * here stub the driver the way `dead-letter.test.ts` does. An exact-name pair that actually
 * merges needs a live graph to check the write, which belongs in the integration file.
 */
const driver = {} as Driver;

const NOW = new Date('2026-08-29T14:00:00.000Z');

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-merge-auto-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM entity_merge_proposals');
});

function ctxFor(config: Config): OperationContext {
  return {
    driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

describe('mergeAutoRelevance', () => {
  it('scales linearly with open entity-merge proposals, same divisor as merge_shadow', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 0,
        entityMergeOpen: 5,
        oldestOpenAgeMs: undefined,
        medianOpenAgeMs: undefined,
      },
    });
    expect(mergeAutoRelevance(health)).toBeCloseTo(0.5, 6);
  });

  it('caps at one past ten open proposals', () => {
    const health = healthFixture({
      proposals: {
        supersessionOpen: 0,
        entityMergeOpen: 40,
        oldestOpenAgeMs: undefined,
        medianOpenAgeMs: undefined,
      },
    });
    expect(mergeAutoRelevance(health)).toBe(1);
  });
});

describe('merge_auto with AION_AUTO_MERGE off', () => {
  it('examines nothing and says the knob is why', async () => {
    recordEntityMergeProposal(db, {
      subject: { id: 'left-1', name: 'Ledger Cache', type: 'tool' },
      candidate: { id: 'right-1', name: 'Ledger Cache', type: 'concept' },
      similarity: 0.95,
      episodeId: 'ep-1',
    });
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: false },
    };

    const result = await mergeAutoOperation().run(ctxFor(config));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'auto-merge disabled by AION_AUTO_MERGE; no proposals examined',
    });
  });
});

describe('merge_auto with only a fuzzy proposal open', () => {
  it('leaves the pair queued without calling the graph', async () => {
    recordEntityMergeProposal(db, {
      subject: { id: 'left-2', name: 'Fenwick Loader', type: 'service' },
      candidate: { id: 'right-2', name: 'Fenwick Batch', type: 'concept' },
      similarity: 0.87,
      episodeId: 'ep-2',
    });
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: true },
    };

    const result = await mergeAutoOperation().run(ctxFor(config));

    expect(result.status).toBe('noop');
    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toBe(
      '0 exact-name proposal(s) auto-merged, 0 cleared, 1 left queued for review',
    );
  });
});

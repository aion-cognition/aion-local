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
import { listEntityMergeDecisions } from '../../../infrastructure/sqlite/entity-merge-decisions.js';
import { DedupFakeGraph } from '../../../reflection/application/stages/entity-dedup.fixture.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The operation is a graph sweep now, not a queue walk, so what it does on a graph holding a
 * duplicate belongs in the integration file where a real server answers the tier-0 predicates.
 * What is provable here is the knob, the empty sweep, and what the engine scores the run on.
 */

const NOW = new Date('2026-08-29T14:00:00.000Z');

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let graph: DedupFakeGraph;

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
  db.exec('DELETE FROM entity_merge_decisions');
  graph = new DedupFakeGraph();
});

function ctxFor(config: Config): OperationContext {
  return {
    driver: graph.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

function healthWithEligible(tier0Eligible: number): ReturnType<typeof healthFixture> {
  return healthFixture({ entities: { tier0Eligible } });
}

function healthWithOpen(entityMergeOpen: number): ReturnType<typeof healthFixture> {
  return healthFixture({
    proposals: {
      supersessionOpen: 0,
      entityMergeOpen,
      oldestOpenAgeMs: undefined,
      medianOpenAgeMs: undefined,
    },
  });
}

describe('mergeAutoRelevance', () => {
  it('scales linearly with the identities the deterministic sweep could absorb', () => {
    expect(mergeAutoRelevance(healthWithEligible(5))).toBeCloseTo(0.5, 6);
  });

  it('caps at one past ten eligible identities', () => {
    expect(mergeAutoRelevance(healthWithEligible(40))).toBe(1);
  });

  /**
   * The sweep is graph-wide and the proposal queue is residue the judge split on, which the
   * sweep never touches. Scoring it on that queue left the operation at zero relevance in
   * every healthy steady state, which is an operation the engine can never select.
   */
  it('stays selectable on a graph with duplicate spellings and an empty proposal queue', () => {
    expect(mergeAutoRelevance(healthWithOpen(0))).toBe(0);
    expect(mergeAutoRelevance(healthFixture({ entities: { tier0Eligible: 2 } }))).toBeGreaterThan(
      0,
    );
  });
});

describe('what the engine scores merge_auto on', () => {
  it('declares the tier-0-eligible count as the number it exists to move down', () => {
    const operation = mergeAutoOperation();

    expect(operation.measure?.(healthWithEligible(7))).toBe(7);
    expect(operation.improves ?? 'lower').toBe('lower');
  });
});

describe('merge_auto with AION_AUTO_MERGE off', () => {
  it('sweeps nothing and says the knob is why', async () => {
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: false },
    };

    const result = await mergeAutoOperation().run(ctxFor(config));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'auto-merge disabled by AION_AUTO_MERGE; nothing swept',
    });
  });
});

describe('merge_auto on a graph holding no duplicate spelling', () => {
  it('reports a clean sweep and records no decision', async () => {
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: true },
    };

    const result = await mergeAutoOperation().run(ctxFor(config));

    expect(result.status).toBe('noop');
    expect(result.itemsProcessed).toBe(0);
    expect(result.itemsAffected).toBe(0);
    expect(listEntityMergeDecisions(db)).toHaveLength(0);
  });
});

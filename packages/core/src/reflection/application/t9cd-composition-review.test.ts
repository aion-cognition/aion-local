import type { Driver } from 'neo4j-driver';
import { afterEach, expect, it, vi } from 'vitest';

import { SourceIndexDrainer } from './index-drain.js';
import { CoveredJudgmentEvidence } from '../../evidence/application/covered-judgment.js';
import * as judgment from '../../evidence/application/judgment.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { prepareCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as indexQueue from '../../introspection/application/source-index-queue.js';

const stores: SqliteStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => {
    store.close();
  });
});
const NOW = new Date('2026-09-09T00:00:00.000Z');
const logger = { warn: () => undefined, debug: () => undefined };
const driver = {} as Driver;
it('lets a proved judgment reach assembly with the production composition', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  stores.push(store);
  prepareCoverageContract(store.db, 1);
  const resolved = {
    status: 'assembled' as const,
    sides: [],
    revision: buildEvidenceRevision([]),
    omitted: [],
  } as unknown as judgment.JudgmentAssembly;
  const assemble = vi.spyOn(judgment, 'assembleJudgmentEvidence').mockResolvedValue(resolved);
  const checkpoint = {
    substrateId: 'test',
    protocolVersion: 1 as const,
    sequence: '0',
    operationId: null,
    intentDigest: null,
    resultDigest: null,
  };
  const resolver = new EvidenceResolver({
    driver,
    db: store.db,
    logger,
    publications: { checkpoint: async () => ({ status: 'ready', checkpoint }) },
  });
  const seam = new CoveredJudgmentEvidence({ db: store.db, resolver, now: () => NOW });
  const pair: judgment.JudgmentPair = {
    route: 'live_supersession',
    reservedUnits: 100,
    use: 'claim_judgment',
    sides: [
      { nodeId: 'a', statement: 'a' },
      { nodeId: 'b', statement: 'b' },
    ],
  };
  const certified = new CoveredJudgmentEvidence({
    db: store.db,
    resolver: new EvidenceResolver({
      driver,
      db: store.db,
      logger,
      publications: { checkpoint: async () => ({ status: 'ready', checkpoint }) },
    }),
    now: () => NOW,
  });
  expect((await certified.assemble(pair)).status).toBe('assembled');
  expect(assemble).toHaveBeenCalledTimes(1);
  expect((await seam.assemble(pair)).status).toBe('assembled');
});
it('does not lose an index-pump request that arrives while a drain is awaiting a read', async () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  stores.push(store);
  let release: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let pendingJobs = 1;
  vi.spyOn(indexQueue, 'drainSourceIndexQueue').mockImplementation(async () => {
    calls += 1;
    const claimed = pendingJobs;
    pendingJobs = 0;
    if (calls === 1) {
      await first;
    }
    return { claimed, completed: claimed, documents: claimed, deferred: 0 };
  });
  const drain = new SourceIndexDrainer({
    db: store.db,
    resolver: new EvidenceResolver({ driver, db: store.db, logger }),
    logger,
    now: () => NOW,
  });
  drain.pump();
  pendingJobs += 1;
  drain.pump();
  release();
  await Promise.allSettled(drain.inFlight());
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect.soft(pendingJobs).toBe(0);
  expect.soft(calls).toBe(2);
});

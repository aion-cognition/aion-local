import type { Driver } from 'neo4j-driver';
import { afterEach, expect, it, vi } from 'vitest';

import { CoveredJudgmentEvidence } from '../../evidence/application/covered-judgment.js';
import * as judgment from '../../evidence/application/judgment.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { prepareCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

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
it('keeps a missing reader refused while accepting the explicit coordinator composition', async () => {
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
  const resolver = new EvidenceResolver({ driver, db: store.db, logger });
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
  const checkpoint = {
    substrateId: 'test',
    protocolVersion: 1 as const,
    sequence: '0',
    operationId: null,
    intentDigest: null,
    resultDigest: null,
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
  expect((await seam.assemble(pair)).status).toBe('incomplete');
});

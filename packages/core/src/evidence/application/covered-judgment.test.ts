import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoveredJudgmentEvidence } from './covered-judgment.js';
import type { JudgmentAssembly, JudgmentPair } from './judgment.js';
import type { EvidenceResolver } from './resolver.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { prepareCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

const NOW = new Date('2026-09-09T05:00:00.000Z');

function pair(): JudgmentPair {
  return {
    route: 'live_supersession',
    reservedUnits: 100,
    use: 'claim_judgment',
    sides: [
      { nodeId: 'claim-1', statement: 'the first' },
      { nodeId: 'claim-2', statement: 'the second' },
    ],
  };
}

/**
 * The adapter decides one thing — whether coverage can be read at all — and delegates the rest.
 * A recording stub stands in for the resolver so the decision is what the case measures.
 */
function recordingResolver(): {
  readonly resolver: EvidenceResolver;
  readonly calls: { readonly vantages: string[] };
} {
  const vantages: string[] = [];
  const stub = {
    assembleJudgment: (_pair: JudgmentPair, context: { readonly now: Date }) => {
      vantages.push(context.now.toISOString());
      return Promise.resolve({
        status: 'assembled',
        sides: [],
        revision: buildEvidenceRevision([]),
        omitted: [],
      } as unknown as JudgmentAssembly);
    },
  };
  return { resolver: stub as unknown as EvidenceResolver, calls: { vantages } };
}

describe('the judgment seam the maintenance loop and the pipeline hold', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-covered-judgment-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to judge when nothing can say what an answer covers', async () => {
    const { resolver, calls } = recordingResolver();
    const seam = new CoveredJudgmentEvidence({ db: store.db, resolver, now: () => NOW });

    const assembly = await seam.assemble(pair());

    expect(assembly.status).toBe('incomplete');
    expect(
      assembly.status === 'incomplete' && assembly.reasons.map((issue) => issue.reason),
    ).toEqual(['store_unavailable', 'store_unavailable']);
    expect(
      assembly.status === 'incomplete' && assembly.reasons.every((issue) => issue.required),
    ).toBe(true);
    expect(calls.vantages).toEqual([]);
  });

  it('judges under the contract in force, on the clock the judgment is made on', async () => {
    prepareCoverageContract(store.db, 1);
    const clocks = [NOW, new Date('2026-09-09T06:00:00.000Z')];
    let call = 0;
    const { resolver, calls } = recordingResolver();
    const seam = new CoveredJudgmentEvidence({
      db: store.db,
      resolver,
      now: () => clocks[call++] ?? NOW,
    });

    expect((await seam.assemble(pair())).status).toBe('assembled');
    expect((await seam.assemble(pair())).status).toBe('assembled');

    // Two judgments, two readings. A vantage taken once at composition would have reported the
    // first clock for every judgment the process ever made.
    expect(calls.vantages).toEqual([clocks[0]?.toISOString(), clocks[1]?.toISOString()]);
  });
});

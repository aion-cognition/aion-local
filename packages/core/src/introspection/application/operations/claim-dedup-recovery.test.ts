import neo4j, { type Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimDedupOperation } from './claim-dedup.js';
import type { JudgmentAssembly } from '../../../evidence/application/judgment.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { PublicationInvariantError } from '../../../infrastructure/publication/errors.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimDedupPairKey, claimDedupScanKey } from '../../domain/claim-dedup.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The batch's failure semantics, exercised through the operation itself.
 *
 * The fake answers the three reads the scan makes and gives the merge a write transaction whose
 * first statement is where a failure is injected, which is what a graph failing mid-merge looks
 * like from here. The merge write's own behavior against a real graph belongs to the integration
 * battery; what is measured here is what the run counts and what it leaves owed.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');

type Claim = { readonly id: string; readonly text: string; readonly occurredAt: Date };

const PAIRS: readonly (readonly [Claim, Claim])[] = [
  [
    { id: 'subject-a', text: 'the ledger runs on Postgres', occurredAt: new Date('2026-09-01') },
    {
      id: 'neighbor-a',
      text: 'we use Postgres for the ledger',
      occurredAt: new Date('2026-08-30'),
    },
  ],
  [
    { id: 'subject-b', text: 'the deploy takes five minutes', occurredAt: new Date('2026-09-02') },
    { id: 'neighbor-b', text: 'a deploy is five minutes', occurredAt: new Date('2026-08-29') },
  ],
  [
    { id: 'subject-c', text: 'the worker runs hourly', occurredAt: new Date('2026-09-03') },
    { id: 'neighbor-c', text: 'the worker ticks every hour', occurredAt: new Date('2026-08-28') },
  ],
];

const COUNTERS = {
  summary: {
    counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }) },
  },
};

function record(fields: Record<string, unknown>): { toObject: () => Record<string, unknown> } {
  return { toObject: () => fields };
}

/** A driver whose write transaction throws whatever the test hands it, for one named pair. */
function fakeDriver(input: { readonly failOn?: string; readonly error?: Error }): Driver {
  const subjects = PAIRS.map(([subject]) => subject);
  const vectorOf = new Map(subjects.map((claim, index) => [claim.id, [index, 0]]));
  const askedBy = new Map(subjects.map((claim, index) => [`${String(index)},0`, claim.id]));
  const neighborOf = new Map(PAIRS.map(([subject, neighbor]) => [subject.id, neighbor]));
  const byId = new Map(PAIRS.flat().map((claim) => [claim.id, claim]));

  const executeQuery = (cypher: string, parameters: Record<string, unknown>): Promise<unknown> => {
    if (cypher.includes('ORDER BY n.occurred_at DESC')) {
      const limit = neo4j.isInt(parameters.limit)
        ? parameters.limit.toNumber()
        : (parameters.limit as number);
      return Promise.resolve({
        records: subjects.slice(0, limit).map((claim) =>
          record({
            id: claim.id,
            label: 'Decision',
            text: claim.text,
            content_vec: vectorOf.get(claim.id),
            occurred_at: claim.occurredAt,
          }),
        ),
      });
    }
    if (cypher.includes('AND NOT n.id IN $excludeIds')) {
      const vector = parameters.vector as number[];
      const asking = askedBy.get(`${String(vector[0])},${String(vector[1])}`);
      const neighbor = asking === undefined ? undefined : neighborOf.get(asking);
      return Promise.resolve({
        records:
          neighbor === undefined
            ? []
            : [
                record({
                  id: neighbor.id,
                  label: 'Decision',
                  text: neighbor.text,
                  score: 0.97,
                  shared_subject: null,
                }),
              ],
      });
    }
    if (cypher.includes('UNWIND $ids AS wantedId')) {
      const ids = (parameters.ids as string[] | undefined) ?? [];
      return Promise.resolve({
        records: ids
          .map((id) => byId.get(id))
          .filter((claim): claim is Claim => claim !== undefined)
          .map((claim) => record({ id: claim.id, occurred_at: claim.occurredAt, current: true })),
      });
    }
    throw new Error(`claim-dedup recovery fake does not model this query: ${cypher}`);
  };

  const session = () => ({
    executeWrite: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> =>
      work({
        run: (cypher: string, parameters: Record<string, unknown>) => {
          const ids = (parameters.ids as string[] | undefined) ?? [];
          if (input.failOn !== undefined && ids.includes(input.failOn)) {
            throw input.error ?? new Error('the write failed');
          }
          if (cypher.includes('RETURN n.id AS id')) {
            return Promise.resolve({
              records: ids.map((id) => record({ id })),
              ...COUNTERS,
            });
          }
          if (cypher.includes('EXTRACTED_FROM')) {
            return Promise.resolve({ records: [], ...COUNTERS });
          }
          // The close and the lineage edge, which report the row they wrote.
          return Promise.resolve({
            records: [
              record({
                id: (parameters.oldId as string | undefined) ?? 'node',
                validUntil: NOW,
                txUntil: NOW,
              }),
            ],
            ...COUNTERS,
          });
        },
      }),
    close: () => Promise.resolve(),
  });
  return { executeQuery, session } as unknown as Driver;
}

function agreeing(): Provider {
  return {
    embed: () => Promise.reject(new Error('claim dedup must never embed')),
    generate: () =>
      Promise.resolve({
        same: true,
        rationale: 'the same fact, said twice',
        either_adds_information: false,
        reason: 'neither adds anything the other lacks',
      }),
  };
}

let db: SqliteHandle;
let logger: Logger;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-dedup-recovery-'));
  db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM ops_ledger');
});

function ctxFor(overrides: Partial<OperationContext>): OperationContext {
  return {
    driver: fakeDriver({}),
    db,
    config: DEFAULTS,
    logger,
    provider: agreeing(),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('claim_dedup when one merge fails', () => {
  it('keeps the tally of the pairs that landed and leaves the failed one owed', async () => {
    const result = await claimDedupOperation().run(
      ctxFor({
        driver: fakeDriver({
          failOn: 'subject-b',
          error: Object.assign(new Error('the leader switched'), {
            code: 'Neo.ClientError.Transaction.LockClientStopped',
          }),
        }),
      }),
    );

    expect(result.status).toBe('applied');
    expect(result.itemsProcessed).toBe(3);
    expect(result.itemsAffected).toBe(2);
    expect(result.detail).toContain('1 failed');
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(true);
    expect(isLedgerApplied(db, claimDedupPairKey('subject-c', 'neighbor-c'))).toBe(true);
    expect(isLedgerApplied(db, claimDedupPairKey('subject-b', 'neighbor-b'))).toBe(false);
    expect(isLedgerApplied(db, claimDedupScanKey('subject-b'))).toBe(false);
  });

  it('propagates a pairing invariant failure instead of counting it as a failed pair', async () => {
    await expect(
      claimDedupOperation().run(
        ctxFor({
          driver: fakeDriver({
            failOn: 'subject-a',
            error: new PublicationInvariantError('pairing_mismatch'),
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(PublicationInvariantError);
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
  });

  it('stops the batch while a publication the coordinator holds is unsettled', async () => {
    const result = await claimDedupOperation().run(
      ctxFor({
        publications: { hasPending: () => true, recover: () => Promise.resolve(undefined) },
      }),
    );

    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toContain('stopped early on publication_still_pending');
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
  });
});

describe('claim_dedup with an evidence seam', () => {
  const abstained: JudgmentAssembly = {
    status: 'abstained',
    reason: 'required_source_suppressed',
    addresses: [{ kind: 'id', id: 'episode-1' }],
    revision: { contractVersion: 1, dependencies: [], digest: 'digest' },
  };

  it('asks no judge about a pair whose required source is suppressed', async () => {
    const assemble = vi.fn(() => Promise.resolve(abstained));
    const result = await claimDedupOperation().run(
      ctxFor({
        provider: refusingProvider,
        evidence: { assemble, confirm: () => ({ status: 'current' }) },
      }),
    );

    expect(result.itemsProcessed).toBe(0);
    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toContain('3 withheld for want of evidence');
    expect(assemble).toHaveBeenCalledTimes(3);
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
    expect(isLedgerApplied(db, claimDedupScanKey('subject-a'))).toBe(false);
  });

  it('judges the pair its evidence supports', async () => {
    const result = await claimDedupOperation().run(
      ctxFor({
        evidence: {
          assemble: () =>
            Promise.resolve({
              status: 'assembled',
              sides: [
                {
                  nodeId: 'subject-a',
                  statement: 'one',
                  requiredSources: [],
                  optionalSubjects: [],
                  renderedUnits: 3,
                },
                {
                  nodeId: 'neighbor-a',
                  statement: 'two',
                  requiredSources: [],
                  optionalSubjects: [],
                  renderedUnits: 3,
                },
              ],
              revision: { contractVersion: 1, dependencies: [], digest: 'digest' },
              omitted: [],
            } satisfies JudgmentAssembly),
          confirm: () => ({ status: 'current' }),
        },
      }),
    );

    expect(result.itemsProcessed).toBe(3);
    expect(result.itemsAffected).toBe(3);
    expect(result.detail).not.toContain('withheld');
  });
});

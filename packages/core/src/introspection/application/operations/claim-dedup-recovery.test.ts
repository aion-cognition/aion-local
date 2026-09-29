import neo4j, { type Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { claimDedupOperation } from './claim-dedup.js';
import { sourceStateDependency } from '../../../evidence/application/dependencies.js';
import type { JudgmentAssembly } from '../../../evidence/application/judgment.js';
import { seedSource } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { PublicationInvariantError } from '../../../infrastructure/publication/errors.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { directMergePublisher } from '../../../reflection/test-support/direct-intake.fixture.js';
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
  // The merge is a destructive write and refuses a binding it cannot re-verify, so the seam these
  // cases run through has to name a source that exists rather than an empty dependency set.
  seedSource(db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { observations: ['evidence'] },
    now: NOW,
  });
});

/** The binding every case here decides on, which the guard re-verifies against this store. */
function judgedRevision() {
  return buildEvidenceRevision([sourceStateDependency(db, 'source')]);
}

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM ops_ledger');
});

function ctxFor(overrides: Partial<OperationContext>): OperationContext {
  // The publisher is built over whichever driver the case supplies, because the merge now runs
  // inside a publication: a fixture holding a second driver would inject its failure into a
  // transaction nobody opened.
  const driver = overrides.driver ?? fakeDriver({});
  return {
    driver,
    db,
    config: DEFAULTS,
    logger,
    provider: agreeing(),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: directMergePublisher(driver, db, () => NOW),
    evidence: {
      assemble: () => Promise.resolve(assembled()),
      confirm: () => ({ status: 'current' }),
    },
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
        publications: {
          ...directMergePublisher(fakeDriver({}), db, () => NOW),
          hasPending: () => true,
          recover: () => Promise.resolve(undefined),
        },
      }),
    );

    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toContain('stopped early on publication_still_pending');
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
  });
});

const MARKER = 'REQUIRED-SOURCE-CONTEXT-COMMIT-0559691';

function assembled(): JudgmentAssembly {
  const source = {
    sourceId: 'source',
    sessionId: 'session',
    occurredAt: NOW.toISOString(),
    text: MARKER,
    sourceText: MARKER,
    parts: [],
    decodedRawUtf8Bytes: MARKER.length,
    rawUtf16CodeUnits: MARKER.length,
  };
  return {
    status: 'assembled',
    sides: [
      {
        evidence: 'whole_sources',
        nodeId: 'subject-a',
        statement: 'one',
        requiredSources: [source],
        optionalSubjects: [],
        renderedContext: MARKER,
        renderedUnits: MARKER.length + 3,
      },
      {
        evidence: 'whole_sources',
        nodeId: 'neighbor-a',
        statement: 'two',
        requiredSources: [source],
        optionalSubjects: [],
        renderedContext: MARKER,
        renderedUnits: MARKER.length + 3,
      },
    ],
    revision: judgedRevision(),
    // The contract the judgment was made under. The merge refuses a decision that names what it
    // read without naming what it was allowed to read.
    coverageEpoch: readCurrentCoverageContract(db)?.epoch,
    omitted: [],
  };
}

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
    expect(result.detail).toContain('3 blocked');
    expect(assemble).toHaveBeenCalledTimes(3);
    // The disposition survives the gate: a consumer sees what is owed, why, and against what.
    expect(result.withheldWork).toHaveLength(3);
    expect(result.withheldWork?.[0]).toMatchObject({
      disposition: 'blocked',
      reason: 'required_source_suppressed',
      addresses: [{ kind: 'id', id: 'episode-1' }],
      revision: { digest: 'digest' },
    });
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
    expect(isLedgerApplied(db, claimDedupScanKey('subject-a'))).toBe(false);
  });

  it('judges the pair its evidence supports', async () => {
    const result = await claimDedupOperation().run(
      ctxFor({
        evidence: {
          assemble: () => Promise.resolve(assembled()),
          confirm: () => ({ status: 'current' }),
        },
      }),
    );

    expect(result.itemsProcessed).toBe(3);
    expect(result.itemsAffected).toBe(3);
    expect(result.detail).not.toContain('withheld');
  });

  it('passes the assembled required source into both real prompt builders', async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      embed: () => Promise.reject(new Error('no embedding')),
      generate: (request) => {
        prompts.push(JSON.stringify(request.messages));
        return Promise.resolve({
          same: true,
          rationale: 'same',
          either_adds_information: false,
          reason: 'same',
        });
      },
    };
    await claimDedupOperation().run(
      ctxFor({
        provider,
        evidence: {
          assemble: () => Promise.resolve(assembled()),
          confirm: () => ({ status: 'current' }),
        },
      }),
    );

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => prompt.includes(MARKER))).toBe(true);
  });

  it('leaves a negative verdict unstamped when the evidence moved under it', async () => {
    const provider: Provider = {
      embed: () => Promise.reject(new Error('no embedding')),
      generate: () => Promise.resolve({ same: false, rationale: 'different scope' }),
    };
    const result = await claimDedupOperation().run(
      ctxFor({
        provider,
        evidence: {
          assemble: () => Promise.resolve(assembled()),
          confirm: () => ({ status: 'stale', changed: [] }),
        },
      }),
    );

    expect(result.detail).toContain('left open on moved evidence');
    expect(isLedgerApplied(db, claimDedupPairKey('subject-a', 'neighbor-a'))).toBe(false);
    expect(isLedgerApplied(db, claimDedupScanKey('subject-a'))).toBe(false);
  });

  it('refuses application when the assembled revision became stale', async () => {
    const confirm = vi.fn(() => ({
      status: 'stale' as const,
      changed: [
        { kind: 'node' as const, id: 'subject-a', scope: 'graph.node_state', version: 'old' },
      ],
    }));
    const result = await claimDedupOperation().run(
      ctxFor({ evidence: { assemble: () => Promise.resolve(assembled()), confirm } }),
    );

    expect(confirm).toHaveBeenCalled();
    expect(result.itemsAffected).toBe(0);
  });
});

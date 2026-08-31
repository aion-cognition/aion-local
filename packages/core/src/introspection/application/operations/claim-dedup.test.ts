import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { claimDedupOperation, claimDedupRelevance } from './claim-dedup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimDedupPairKey } from '../../domain/claim-dedup.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * A fake recognising the three read shapes this operation issues (the recent-claims scan, the
 * nearest-neighbor search, and the pre-write currency re-check), the same way
 * `proposal-hygiene.test.ts` models its own two. It never models `.session()`: a unanimous
 * merge needs a real write transaction, which belongs in `claim-dedup.int.test.ts`.
 */
type FakeClaim = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly occurredAt: Date;
};

function fakeDriver(subject: FakeClaim, neighbor?: FakeClaim): Driver {
  const executeQuery = (cypher: string, parameters: Record<string, unknown>): Promise<unknown> => {
    if (cypher.includes('ORDER BY n.occurred_at DESC')) {
      return Promise.resolve({
        records: [
          {
            toObject: () => ({
              id: subject.id,
              label: subject.label,
              text: subject.text,
              content_vec: [0.1, 0.2],
              occurred_at: subject.occurredAt,
            }),
          },
        ],
      });
    }
    if (cypher.includes('AND NOT n.id IN $excludeIds')) {
      const excludeIds = (parameters.excludeIds as string[] | undefined) ?? [];
      if (neighbor === undefined || excludeIds.includes(neighbor.id)) {
        return Promise.resolve({ records: [] });
      }
      return Promise.resolve({
        records: [
          {
            toObject: () => ({
              id: neighbor.id,
              label: neighbor.label,
              text: neighbor.text,
              score: 0.97,
              shared_subject: null,
            }),
          },
        ],
      });
    }
    if (cypher.includes('UNWIND $ids AS wantedId')) {
      const ids = (parameters.ids as string[] | undefined) ?? [];
      const byId = new Map(
        [subject, ...(neighbor === undefined ? [] : [neighbor])].map((c) => [c.id, c]),
      );
      const records = ids
        .map((id) => byId.get(id))
        .filter((claim): claim is FakeClaim => claim !== undefined)
        .map((claim) => ({
          toObject: () => ({ id: claim.id, occurred_at: claim.occurredAt, current: true }),
        }));
      return Promise.resolve({ records });
    }
    throw new Error(`claim-dedup fake driver does not model this query: ${cypher}`);
  };
  return { executeQuery } as unknown as Driver;
}

function answering(...answers: unknown[]): Provider {
  let call = 0;
  return {
    embed: () => Promise.reject(new Error('claim dedup must never embed')),
    generate: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return Promise.resolve(answer);
    },
  };
}

const NOW = new Date('2026-08-31T12:00:00.000Z');
const SUBJECT: Omit<FakeClaim, 'occurredAt'> = {
  id: 'subject-1',
  label: 'Decision',
  text: 'we use Postgres for the ledger',
};
const NEIGHBOR: Omit<FakeClaim, 'occurredAt'> = {
  id: 'neighbor-1',
  label: 'Decision',
  text: 'the ledger runs on Postgres',
};

let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-dedup-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM ops_ledger');
});

function ctxFor(
  overrides: Partial<OperationContext> = {},
  config: Config = DEFAULTS,
): OperationContext {
  return {
    driver: {} as Driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function subjectAt(occurredAt: Date): FakeClaim {
  return { ...SUBJECT, occurredAt };
}

function neighborAt(occurredAt: Date): FakeClaim {
  return { ...NEIGHBOR, occurredAt };
}

describe('claimDedupRelevance', () => {
  it('is a standing constant, since no gauge in the snapshot measures near-duplication', () => {
    expect(claimDedupRelevance()).toBe(0.1);
  });
});

describe('claim_dedup with the knob off', () => {
  it('examines nothing and says the knob is why', async () => {
    const config: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, claimDedup: false },
    };

    const result = await claimDedupOperation().run(ctxFor({}, config));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'claim dedup disabled by AION_MAINTENANCE_CLAIM_DEDUP; no claims examined',
    });
  });
});

describe('claim_dedup with no recent claims', () => {
  it('reports a clean noop without calling the judge', async () => {
    const driver = fakeDriver({ ...SUBJECT, occurredAt: NOW });
    // No neighbor is seeded, so the nearest-neighbor search always comes back empty.
    const result = await claimDedupOperation().run(ctxFor({ driver, provider: refusingProvider }));

    expect(result.status).toBe('noop');
    expect(result.itemsProcessed).toBe(0);
  });
});

describe('claim_dedup judge routing', () => {
  it('ledgers a pair the first pass calls related, and leaves both claims untouched', async () => {
    const driver = fakeDriver(subjectAt(NOW), neighborAt(new Date(NOW.getTime() - 1000)));
    const provider = answering({
      same: false,
      rationale: 'different attribute of the same subject',
    });

    const result = await claimDedupOperation().run(ctxFor({ driver, provider }));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 1,
      itemsAffected: 0,
      detail: '1 pair(s) judged: 0 merged, 1 related, 0 vetoed, 0 stale, 0 failed',
    });
    const entry = getLedgerEntry(db, claimDedupPairKey(SUBJECT.id, NEIGHBOR.id));
    expect(entry?.summary).toMatchObject({ verdict: 'related' });
  });

  it('ledgers a pair the second pass vetoes, and leaves both claims untouched', async () => {
    const driver = fakeDriver(subjectAt(NOW), neighborAt(new Date(NOW.getTime() - 1000)));
    const provider = answering(
      { same: true, rationale: 'both name the ledger store' },
      { either_adds_information: true, reason: 'only one names Postgres by name' },
    );

    const result = await claimDedupOperation().run(ctxFor({ driver, provider }));

    expect(result.itemsAffected).toBe(0);
    const entry = getLedgerEntry(db, claimDedupPairKey(SUBJECT.id, NEIGHBOR.id));
    expect(entry?.summary).toMatchObject({
      verdict: 'vetoed',
      reason: 'only one names Postgres by name',
    });
  });

  it('does not ledger a pair when the first pass fails, so a later run retries it', async () => {
    const driver = fakeDriver(subjectAt(NOW), neighborAt(new Date(NOW.getTime() - 1000)));
    const provider: Provider = {
      embed: () => Promise.reject(new Error('must not embed')),
      generate: () => Promise.reject(new Error('model unavailable')),
    };

    const result = await claimDedupOperation().run(ctxFor({ driver, provider }));

    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toContain('1 failed');
    expect(getLedgerEntry(db, claimDedupPairKey(SUBJECT.id, NEIGHBOR.id))).toBeUndefined();
  });

  it('does not ledger a pair when the second pass fails, so a later run retries it', async () => {
    const driver = fakeDriver(subjectAt(NOW), neighborAt(new Date(NOW.getTime() - 1000)));
    let call = 0;
    const provider: Provider = {
      embed: () => Promise.reject(new Error('must not embed')),
      generate: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({ same: true, rationale: 'restated' });
        }
        return Promise.reject(new Error('model unavailable'));
      },
    };

    const result = await claimDedupOperation().run(ctxFor({ driver, provider }));

    expect(result.itemsAffected).toBe(0);
    expect(result.detail).toContain('1 failed');
    expect(getLedgerEntry(db, claimDedupPairKey(SUBJECT.id, NEIGHBOR.id))).toBeUndefined();
  });

  it('never calls the judge on a pair already ledgered from an earlier run', async () => {
    const driver = fakeDriver(subjectAt(NOW), neighborAt(new Date(NOW.getTime() - 1000)));
    markLedgerApplied(db, claimDedupPairKey(SUBJECT.id, NEIGHBOR.id), { verdict: 'related' });

    const result = await claimDedupOperation().run(ctxFor({ driver, provider: refusingProvider }));

    expect(result).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: '0 pair(s) judged: 0 merged, 0 related, 0 vetoed, 0 stale, 0 failed',
    });
  });
});

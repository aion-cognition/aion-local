import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCoverage, type CheckedRead } from './coverage-checker.js';
import {
  completeCheckedRead,
  type CheckedReadEffects,
  type ReadCoordinator,
} from './read-completion.js';
import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import type {
  CheckpointResult,
  PublicationCheckpoint,
} from '../../infrastructure/publication/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { publicationWrite } from '../../infrastructure/sqlite/publication-bounded.js';
import {
  deleteServedItems,
  readServedItems,
  recordServedItems,
} from '../../infrastructure/sqlite/served-items.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const H = new Date('2026-09-08T02:00:00.000Z');
const SESSION = 'session-1';

/** These cases are about which writes reach SQLite, so the graph half of the boundary is inert. */
const STUB_GRAPH = new GraphTransaction({
  run: () => {
    throw new Error('graph reads are stubbed here');
  },
});

const CHECKPOINT: PublicationCheckpoint = {
  substrateId: 'substrate-1',
  protocolVersion: 1,
  sequence: '4',
  operationId: null,
  intentDigest: null,
  resultDigest: null,
};

let dir: string;
let store: SqliteStore;
/** Effects that ran, and the transaction each one saw, so the fence and the writes stay paired. */
let inTransaction: boolean[];
let attempts: number;
/** Runs after validation and before the completion transaction, where a writer lands. */
let beforeCompletion: (() => void) | undefined;
let pending: boolean;
let position: PublicationCheckpoint;

/**
 * The coordinator boundary, with its real SQLite half. The graph side is stubbed; what these
 * cases are about is which writes reach the store and under which contract.
 */
const coordinator: ReadCoordinator = {
  checkpoint(): Promise<CheckpointResult> {
    return Promise.resolve(
      pending
        ? { status: 'unavailable', reason: 'pending_publication' }
        : { status: 'ready', checkpoint: position },
    );
  },
  async completeRead(checkpoint, validate, complete) {
    attempts += 1;
    if (pending) {
      return { status: 'retry', reason: 'pending_publication' };
    }
    if (checkpoint.sequence !== position.sequence) {
      return { status: 'retry', reason: 'publication_changed' };
    }
    if (
      !(await validate({
        operationId: 'read_completion',
        sequence: null,
        graph: STUB_GRAPH,
        db: store.db,
        now: NOW,
      }))
    ) {
      return { status: 'retry', reason: 'evidence_changed' };
    }
    beforeCompletion?.();
    return { status: 'completed', value: publicationWrite(store.db, () => complete(store.db)) };
  },
};

function activate(at: Date = H): void {
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: at, fieldPolicyVersion: 1 });
}

function checked(): CheckedRead {
  const result = checkCoverage(store.db, {
    knewAt: '2026-09-08T04:00:00.000Z',
    now: NOW,
    expiryAnnotation: true,
  });
  if (result.status !== 'checked') {
    throw new Error('the fixture contract answers');
  }
  return { context: result.context, coverage: result.coverage };
}

function effects(over: Partial<CheckedReadEffects<number>> = {}): CheckedReadEffects<number> {
  return {
    read: checked(),
    checkpoint: CHECKPOINT,
    persist: (db) => {
      inTransaction.push(db.inTransaction);
      markLedgerApplied(db, 'read-completed', attempts);
      return attempts;
    },
    ...over,
  };
}

function reset(db: SqliteHandle): void {
  inTransaction.push(db.inTransaction);
  deleteServedItems(db, SESSION);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-read-completion-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  inTransaction = [];
  attempts = 0;
  beforeCompletion = undefined;
  pending = false;
  position = CHECKPOINT;
  activate();
  recordServedItems(store.db, SESSION, [{ itemId: 'node-1', fingerprint: 'a' }], NOW.toISOString());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('when the contract still holds', () => {
  it('persists the effects and reports the context the answer was computed under', async () => {
    const request = effects();

    const outcome = await completeCheckedRead(coordinator, request);

    expect(outcome).toEqual({ status: 'completed', value: 1, read: request.read });
    expect(getLedgerEntry(store.db, 'read-completed')?.summary).toBe(1);
  });

  it('deletes the served rows the caller asked to forget, in the same transaction', async () => {
    const outcome = await completeCheckedRead(coordinator, effects({ resetDelivery: reset }));

    expect(outcome.status).toBe('completed');
    expect(readServedItems(store.db, SESSION).size).toBe(0);
    expect(inTransaction).toEqual([true, true]);
  });
});

describe('when the coverage record changes under the read', () => {
  it('keeps the holdings and refuses rather than committing under a contract it did not check', async () => {
    beforeCompletion = () => {
      activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    };

    const outcome = await completeCheckedRead(coordinator, effects({ resetDelivery: reset }));

    expect(outcome).toMatchObject({
      status: 'refused',
      refusal: {
        reason: 'coverage_changed',
        requested: { knew_at: '2026-09-08T04:00:00.000Z', now: NOW.toISOString() },
        bounds: { history_since: H.toISOString(), coverage_state: 'active' },
      },
    });
    expect(readServedItems(store.db, SESSION).size).toBe(1);
    expect(getLedgerEntry(store.db, 'read-completed')).toBeUndefined();
    expect(inTransaction).toEqual([]);
  });

  it('commits a result rebuilt against the contract now in force', async () => {
    beforeCompletion = () => {
      activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
      beforeCompletion = undefined;
    };

    const outcome = await completeCheckedRead(coordinator, effects(), (change) => {
      expect(change.currentEpoch).not.toBe(change.checkedEpoch);
      return Promise.resolve({ status: 'reconstructed', effects: effects() });
    });

    expect(outcome).toMatchObject({ status: 'completed', value: 2 });
    expect(outcome.status === 'completed' && outcome.read.context.coverageEpoch).toBe(
      checked().context.coverageEpoch,
    );
    expect(getLedgerEntry(store.db, 'read-completed')?.summary).toBe(2);
    expect(attempts).toBe(2);
  });

  it('revalidates once, then refuses rather than chasing a moving contract', async () => {
    beforeCompletion = () => {
      activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    };

    const outcome = await completeCheckedRead(coordinator, effects(), () =>
      Promise.resolve({ status: 'reconstructed', effects: effects() }),
    );

    expect(outcome).toMatchObject({ status: 'refused', refusal: { reason: 'coverage_changed' } });
    expect(attempts).toBe(2);
    expect(getLedgerEntry(store.db, 'read-completed')).toBeUndefined();
  });

  it('refuses when the caller has nothing to rebuild from', async () => {
    beforeCompletion = () => {
      activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    };

    const outcome = await completeCheckedRead(coordinator, effects(), () =>
      Promise.resolve({ status: 'abandoned' }),
    );

    expect(outcome).toMatchObject({ status: 'refused', refusal: { reason: 'coverage_changed' } });
    expect(attempts).toBe(1);
  });
});

describe('when the coverage record stops being readable', () => {
  it('refuses with no bounds, since nothing can say what the substrate reaches', async () => {
    beforeCompletion = () => {
      store.db.prepare('DROP TABLE coverage_contract').run();
    };

    const outcome = await completeCheckedRead(coordinator, effects({ resetDelivery: reset }));

    expect(outcome).toMatchObject({
      status: 'refused',
      refusal: { reason: 'coverage_store_unavailable', bounds: {} },
    });
    expect(readServedItems(store.db, SESSION).size).toBe(1);
    expect(getLedgerEntry(store.db, 'read-completed')).toBeUndefined();
  });
});

describe('when the publication boundary will not take the effects', () => {
  it('holds the effects back while a publication is pending, and says so', async () => {
    pending = true;

    const outcome = await completeCheckedRead(coordinator, effects({ resetDelivery: reset }));

    expect(outcome).toEqual({ status: 'retry', reason: 'pending_publication' });
    expect(readServedItems(store.db, SESSION).size).toBe(1);
    expect(getLedgerEntry(store.db, 'read-completed')).toBeUndefined();
  });

  it('holds them back on a stale position rather than persisting under a newer one', async () => {
    position = { ...CHECKPOINT, sequence: '5' };

    const outcome = await completeCheckedRead(coordinator, effects({ resetDelivery: reset }));

    expect(outcome).toEqual({ status: 'retry', reason: 'publication_changed' });
    expect(readServedItems(store.db, SESSION).size).toBe(1);
    expect(inTransaction).toEqual([]);
  });

  it('holds them back when the caller finds its evidence changed under the guard', async () => {
    const outcome = await completeCheckedRead(
      coordinator,
      effects({ validate: () => Promise.resolve(false) }),
    );

    expect(outcome).toEqual({ status: 'retry', reason: 'evidence_changed' });
    expect(getLedgerEntry(store.db, 'read-completed')).toBeUndefined();
  });
});

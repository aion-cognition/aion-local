import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  freezeMigrationCohort,
  readMigrationProgress,
  recordMigrationProgress,
} from './migration-cohorts.js';
import {
  listMigrationRemainder,
  readMigrationPolicy,
  rememberMigrationOrder,
  rememberMigrationPolicy,
  sourceReservedForMigration,
  sealMigrationMembership,
} from './migration-partition.js';
import { beginNarrativeMigration } from './narrative-migration-job.js';
import { readSourceRecord } from './source-identity.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';

const NOW = new Date('2026-09-10T02:00:00.000Z');
const OLD = '2020-01-01T00:00:00.000Z';
const POLICY = {
  maxMembers: 24,
  renderedInputAllowance: 16384,
  maxSpanMs: 86400000,
  partitionPolicyVersion: 1,
};

describe('fixed historical partition records', () => {
  let directory: string;
  let path: string;
  let store: SqliteStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aion-partition-'));
    path = join(directory, 'store.sqlite');
    store = new SqliteStore({ filePath: path });
    for (const sourceId of ['b', 'a', 'tail']) {
      seedSource(store.db, {
        sourceId,
        sessionId: 'session',
        identity: sourceId,
        content: { observations: [sourceId] },
        now: NOW,
      });
    }
    freezeMigrationCohort(store.db, {
      cohortId: 'cohort',
      cohortDigest: 'fixture',
      intakeWatermark: 2,
      archiveRowidLow: 1,
      archiveRowidHigh: 2,
      graphCensusDigest: 'fixture',
      orderingPolicyVersion: 1,
      createdAt: NOW,
      members: ['a', 'b'],
    });
    for (const sourceId of ['a', 'b']) {
      recordMigrationProgress(store.db, { cohortId: 'cohort', sourceId, status: 'verified' });
    }
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function order(sourceId: string, value = OLD): void {
    store.db
      .transaction(() => {
        rememberMigrationOrder(store.db, {
          cohortId: 'cohort',
          sourceId,
          value,
          basis: 'graph_tx_from',
        });
      })
      .immediate();
  }

  it('reserves only the frozen cohort while a nonterminal job owns it', () => {
    expect(sourceReservedForMigration(store.db, 'a')).toBe(false);
    rememberMigrationPolicy(store.db, 'cohort', POLICY);
    expect(sourceReservedForMigration(store.db, 'a')).toBe(false);
    beginNarrativeMigration(store.db, { cohortId: 'cohort', policy: POLICY, now: NOW });
    expect(sourceReservedForMigration(store.db, 'a')).toBe(true);
    expect(sourceReservedForMigration(store.db, 'tail')).toBe(false);
    expect(readMigrationPolicy(store.db, 'cohort')).toEqual(POLICY);
    rememberMigrationPolicy(store.db, 'cohort', POLICY);
    expect(() => {
      rememberMigrationPolicy(store.db, 'cohort', { ...POLICY, maxMembers: 25 });
    }).toThrow('cannot change');
  });

  it('keeps timestamp ordering separate from the live ingest value and immutable on later proof', () => {
    const live = readSourceRecord(store.db, 'a')?.captureOrderValue;
    order('a');
    order('a', '2010-01-01T00:00:00.000Z');
    expect(readSourceRecord(store.db, 'a')?.captureOrderValue).toBe(live);
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)[0]).toMatchObject({
      sourceId: 'a',
      captureOrderValue: OLD,
      captureOrderBasis: 'graph_tx_from',
    });
  });

  it('breaks equal capture stamps by the original source id', () => {
    order('b');
    order('a');
    expect(
      listMigrationRemainder(store.db, 'cohort', 'session', 10).map((row) => row.sourceId),
    ).toEqual(['a', 'b']);
  });

  it('records an ordering gap without falsifying completed raw verification', () => {
    store.db
      .transaction(() => {
        rememberMigrationOrder(store.db, {
          cohortId: 'cohort',
          sourceId: 'a',
          gap: 'no provable original clock',
        });
      })
      .immediate();
    expect(readMigrationProgress(store.db, 'cohort', 'a')?.status).toBe('verified');
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)).toEqual([]);
    expect(
      store.db.prepare('SELECT partition_gap FROM migration_progress WHERE source_id = ?').get('a'),
    ).toEqual({ partition_gap: 'no provable original clock' });
    order('a');
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)).toHaveLength(1);
  });

  it('rejects permissive date-parser spellings without saving an invented capture time', () => {
    for (const value of ['0', '1', 'September 1, 2026', '2026/09/01']) {
      expect(() => {
        order('a', value);
      }).toThrow('recorded instant');
    }
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)).toEqual([]);
  });

  it('requires the publication transaction and rejects a source whose verification was withdrawn', () => {
    expect(() => {
      rememberMigrationOrder(store.db, {
        cohortId: 'cohort',
        sourceId: 'a',
        value: OLD,
        basis: 'graph_tx_from',
      });
    }).toThrow('publication transaction');
    store.db
      .prepare(
        "UPDATE source_records SET verification_status = 'pinned', verification_reason = 'withdrawn' WHERE source_id = ?",
      )
      .run('a');
    expect(() => {
      order('a');
    }).toThrow('verified frozen member');
  });

  it('rolls back an ordering assignment with the enclosing publication', () => {
    expect(() =>
      store.db
        .transaction(() => {
          rememberMigrationOrder(store.db, {
            cohortId: 'cohort',
            sourceId: 'a',
            value: OLD,
            basis: 'graph_tx_from',
          });
          throw new Error('interrupted');
        })
        .immediate(),
    ).toThrow('interrupted');
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)).toEqual([]);
  });

  it('rechecks raw verification even when a repeated seal already owns the same membership', () => {
    rememberMigrationPolicy(store.db, 'cohort', POLICY);
    order('a');
    const members = listMigrationRemainder(store.db, 'cohort', 'session', 10);
    const first = sealMigrationMembership(store.db, {
      cohortId: 'cohort',
      sessionId: 'session',
      members,
      at: NOW,
    });
    expect(first.created).toBe(true);
    store.db
      .prepare(
        "UPDATE source_records SET verification_status = 'pinned', verification_reason = 'withdrawn' WHERE source_id = 'a'",
      )
      .run();
    expect(() =>
      sealMigrationMembership(store.db, {
        cohortId: 'cohort',
        sessionId: 'session',
        members,
        at: NOW,
      }),
    ).toThrow('verified migration membership');
    expect(readSourceRecord(store.db, 'a')?.verificationStatus).toBe('pinned');
    expect(readMigrationProgress(store.db, 'cohort', 'a')?.partitionAssignment).toBe(first.chunkId);
  });

  it('reopens the saved policy/order and adds nullable fields on a legacy schema', () => {
    rememberMigrationPolicy(store.db, 'cohort', POLICY);
    order('a');
    store.close();
    store = new SqliteStore({ filePath: path });
    expect(readMigrationPolicy(store.db, 'cohort')).toEqual(POLICY);
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)[0]?.captureOrderValue).toBe(
      OLD,
    );
    store.db.exec(
      'ALTER TABLE migration_progress RENAME COLUMN capture_order_value TO old_order_value',
    );
    store.db.exec(
      'ALTER TABLE migration_progress RENAME COLUMN capture_order_basis TO old_order_basis',
    );
    store.db.exec(
      'ALTER TABLE migration_progress RENAME COLUMN partition_gap TO old_partition_gap',
    );
    store.db.exec(
      'ALTER TABLE migration_cohorts RENAME COLUMN partition_policy_json TO old_partition_policy',
    );
    store.close();
    store = new SqliteStore({ filePath: path });
    expect(readMigrationPolicy(store.db, 'cohort')).toBeUndefined();
    expect(listMigrationRemainder(store.db, 'cohort', 'session', 10)).toEqual([]);
    expect(
      store.db
        .prepare('SELECT old_order_value FROM migration_progress WHERE source_id = ?')
        .get('a'),
    ).toEqual({ old_order_value: OLD });
  });
});

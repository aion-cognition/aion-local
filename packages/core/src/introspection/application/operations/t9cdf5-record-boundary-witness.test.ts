import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { decideRecord } from './claim-dedup-record.js';
import type { JudgmentEvidenceOutcome } from '../../../evidence/application/judgment.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimDedupScanKey } from '../../domain/claim-dedup.js';

/**
 * The lock the record boundary actually holds, witnessed rather than argued.
 *
 * The native race proves the outcome across two processes; this proves the mechanism behind it in
 * one, and cheaply enough to run on every change. A second connection tries to write at the exact
 * moment the boundary is checking, and has to be refused: that refusal is what makes a coverage
 * activation unable to land between the check and the stamp.
 */

const EPOCH = 'epoch-1';
const PAIR = 'claim_dedup.pair:subject:candidate';
const COMPETING =
  "INSERT INTO ops_ledger (key, applied_at, summary_json) VALUES ('competing', '2026-01-01T00:00:00.000Z', NULL)";

let dir: string;
let store: SqliteStore;
let other: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-record-boundary-'));
  store = new SqliteStore({ filePath: join(dir, 'store.sqlite') });
  other = new Database(join(dir, 'store.sqlite'));
  other.pragma('busy_timeout = 0');
});

afterEach(() => {
  other.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function assembled(): JudgmentEvidenceOutcome {
  const side = {
    evidence: 'whole_sources' as const,
    nodeId: 'subject',
    statement: 'one',
    requiredSources: [],
    optionalSubjects: [],
    renderedContext: '',
    renderedUnits: 1,
  };
  return {
    status: 'ready',
    sides: [side, { ...side, nodeId: 'candidate' }],
    revision: buildEvidenceRevision([]),
    coverageEpoch: EPOCH,
  };
}

/** Runs while the boundary is deciding, which is the moment the race is about. */
function competingWrite(codes: string[]): void {
  try {
    other.prepare(COMPETING).run();
    codes.push('committed');
  } catch (err) {
    codes.push((err as { code?: string }).code ?? 'unknown');
  }
}

function decisionFor(
  confirm: () => { status: 'current' } | { status: 'uncovered'; reason: 'epoch_changed' },
  tally: { open: () => void; failed: () => void },
) {
  return decideRecord(
    {
      db: store.db,
      logger: { info: () => undefined, warn: () => undefined },
      evidence: {
        assemble: () => Promise.reject(new Error('no assembly in this witness')),
        confirm,
      },
    },
    { subjectId: 'subject', candidateId: 'candidate', pairKey: PAIR, assembled: assembled() },
    tally,
  );
}

it('refuses a competing writer between the check and both stamps', () => {
  const codes: string[] = [];
  let open = 0;
  let failed = 0;
  const decision = decisionFor(
    () => {
      competingWrite(codes);
      return { status: 'current' };
    },
    {
      open: () => {
        open += 1;
      },
      failed: () => {
        failed += 1;
      },
    },
  );

  expect(decision.record('related', { rationale: 'different proposition' })).toBe(true);
  expect(codes).toHaveLength(1);
  expect(codes[0]).toMatch(/^SQLITE_BUSY/);
  expect(open).toBe(0);
  expect(failed).toBe(0);
  expect(getLedgerEntry(store.db, PAIR)?.summary).toMatchObject({ verdict: 'related' });
  expect(getLedgerEntry(store.db, claimDedupScanKey('subject'))?.summary).toMatchObject({
    verdict: 'related',
  });
  // The boundary released with the decision committed, and the write that was held out lands.
  competingWrite(codes);
  expect(codes[1]).toBe('committed');
});

it('stamps nothing when the vantage moved, and lets the competing writer through', () => {
  const codes: string[] = [];
  let open = 0;
  let failed = 0;
  const decision = decisionFor(
    () => {
      competingWrite(codes);
      return { status: 'uncovered', reason: 'epoch_changed' };
    },
    {
      open: () => {
        open += 1;
      },
      failed: () => {
        failed += 1;
      },
    },
  );

  expect(decision.record('related', { rationale: 'different proposition' })).toBe(false);
  expect(open).toBe(1);
  expect(failed).toBe(0);
  expect(getLedgerEntry(store.db, PAIR)).toBeUndefined();
  expect(getLedgerEntry(store.db, claimDedupScanKey('subject'))).toBeUndefined();
  competingWrite(codes);
  expect(codes[1]).toBe('committed');
});

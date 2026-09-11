import type { HistoryCoverage } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { checkCoverage, readCoverageFence, type CoverageCheck } from './coverage-checker.js';
import { coverageGapId, decodeCoverageGapId, applyEvidence } from './coverage-reasons.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const H = new Date('2026-09-08T02:00:00.000Z');

let dir: string;
let store: SqliteStore;

function check(request: { asOf?: string; knewAt?: string; now?: Date }): CoverageCheck {
  return checkCoverage(store.db, {
    ...(request.asOf === undefined ? {} : { asOf: request.asOf }),
    ...(request.knewAt === undefined ? {} : { knewAt: request.knewAt }),
    now: request.now ?? NOW,
    expiryAnnotation: true,
  });
}

function activate(): void {
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: H, fieldPolicyVersion: 1 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-coverage-check-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['history_since', 'activated_at'])(
  'refuses malformed %s in an otherwise readable active registry',
  (field) => {
    activate();
    store.db
      .prepare(`UPDATE coverage_contract SET ${field} = 'not-a-time' WHERE state = 'active'`)
      .run();
    expect
      .soft(check({}))
      .toMatchObject({ status: 'refused', refusal: { reason: 'coverage_store_unavailable' } });
    expect
      .soft(check({ knewAt: '2026-09-08T01:00:00.000Z' }))
      .toMatchObject({ status: 'refused', refusal: { reason: 'coverage_store_unavailable' } });
    expect.soft(readCoverageFence(store.db)).toBeUndefined();
  },
);

it('refuses active timestamps that disagree about the fixed initial horizon', () => {
  activate();
  store.db
    .prepare(
      "UPDATE coverage_contract SET history_since='2020-01-01T00:00:00.000Z' WHERE state='active'",
    )
    .run();
  expect(check({ knewAt: '2021-01-01T00:00:00.000Z' })).toMatchObject({
    status: 'refused',
    refusal: { reason: 'coverage_store_unavailable' },
  });
});

it('does not recognize a negative part ordinal as a canonical part address', () => {
  expect(decodeCoverageGapId('part:source:turn:-1')).toEqual({
    kind: 'node',
    id: 'part:source:turn:-1',
  });
});

it('refuses to encode a negative part ordinal', () => {
  expect(() =>
    coverageGapId({ kind: 'part', sourceId: 'source', partKind: 'turn', ordinal: -1 }),
  ).toThrow();
});

it('bounds inherited gap lists as well as appended ones', () => {
  const base: HistoryCoverage = {
    contract_version: 1,
    status: 'partial',
    limitations: [],
    gaps: Array.from({ length: 33 }, (_, i) => ({
      id: `source-${i}`,
      field: 'source_content',
      reason: 'unresolved_mapping',
    })),
  };
  const result = applyEvidence(base, []).coverage;
  expect.soft(result.gaps).toHaveLength(32);
  expect.soft(result.limitations).toContain('gap_list_truncated');
});

import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { readClaimSubjects } from './subjects.js';
import { asOf } from '../../infrastructure/graph/read-modes.js';
import * as subjectGraph from '../../infrastructure/graph/subject-family.js';
import * as incidence from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../domain/budget.js';
import {
  checkedContext,
  commitIncidence,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

const CAPTURE = new Date('2026-09-08T08:00:00.000Z');
const QUESTION = new Date('2026-09-08T09:00:00.000Z');
const driver = { executeQuery: vi.fn(async () => ({ records: [] })) } as unknown as Driver;
const knownSubject = {
  entityId: 'known',
  name: 'Atlas',
  nameNorm: 'atlas',
  sourceEpisodeId: 'source',
};
let store: SqliteStore;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-subject-budget-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['turn'],
    now: CAPTURE,
  });
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'claim',
    role: 'extraction',
    operationId: 'extract',
    at: CAPTURE,
  });
  for (const nodeId of ['known', 'ended-a', 'ended-b', 'ended-c', 'ended-d']) {
    commitIncidence(store.db, {
      sourceId: 'source',
      nodeId,
      role: 'mention',
      operationId: nodeId,
      at: CAPTURE,
    });
    if (nodeId !== 'known') {
      store.db
        .prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?')
        .run(
          JSON.stringify({ currency: 'closed', valid_until: CAPTURE.toISOString() }),
          `source:${nodeId}:mention`,
        );
    }
  }
  establishScope(store.db, 'claim', 'sqlite:extraction:out', CAPTURE);
  establishScope(store.db, 'source', 'sqlite:mention:out', CAPTURE);
  vi.spyOn(subjectGraph, 'findClaimSubjects').mockResolvedValue([knownSubject]);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('bounds durable proof reads even when the graph returns a small answer', async () => {
  const anchors = vi.spyOn(incidence, 'committedIncidenceForNodesAt');
  const mentions = vi.spyOn(incidence, 'committedIncidenceForSourceAt');
  const budget = new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 2 });
  const result = await readClaimSubjects(
    { db: store.db, driver },
    {
      claimIds: ['claim'],
      context: checkedContext({ mode: asOf(QUESTION) }),
      budget,
    },
  );
  const rowsRead = [...anchors.mock.results, ...mentions.mock.results].reduce(
    (sum, read) => sum + (read.type === 'return' ? read.value.length : 0),
    0,
  );
  console.info({ rowsRead, spent: budget.spent(), issues: result.issues });
  expect.soft(rowsRead).toBeLessThanOrEqual(budget.limits.relationRows);
  expect
    .soft(result.issues.some((issue) => issue.reason === 'budget_limit' && issue.required))
    .toBe(true);
  expect.soft(result.results.get('["id","claim"]')?.evidence.status).toBe('incomplete');
});

it('keeps a proved small answer complete when the entire proof fits', async () => {
  const budget = new RequestBudget(EVIDENCE_LIMITS);
  const result = await readClaimSubjects(
    { db: store.db, driver },
    {
      claimIds: ['claim'],
      context: checkedContext({ mode: asOf(QUESTION) }),
      budget,
    },
  );
  expect(result.results.get('["id","claim"]')).toMatchObject({
    value: [knownSubject],
    evidence: { status: 'complete-for-use' },
  });
});

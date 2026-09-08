import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { readClaimSubjects } from './subjects.js';
import { asOf } from '../../infrastructure/graph/read-modes.js';
import * as subjectGraph from '../../infrastructure/graph/subject-family.js';
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
let store: SqliteStore;
let dir: string;
// The source projection is absent, so the graph cannot answer the join.
const driver = { executeQuery: vi.fn(async () => ({ records: [] })) } as unknown as Driver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-subject-proof-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['turn'],
    now: CAPTURE,
  });
  for (const [nodeId, role] of [
    ['claim', 'extraction'],
    ['entity', 'mention'],
  ] as const) {
    commitIncidence(store.db, { sourceId: 'source', nodeId, role, operationId: role, at: CAPTURE });
  }
  establishScope(store.db, 'claim', 'sqlite:extraction:out', CAPTURE);
  establishScope(store.db, 'source', 'sqlite:mention:out', CAPTURE);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function recordedClose(values: Record<string, string>): void {
  store.db
    .prepare(
      "UPDATE evidence_link_versions SET state='closed',recorded_values_json=? WHERE link_id=?",
    )
    .run(JSON.stringify({ currency: 'closed', ...values }), 'source:entity:mention');
  store.db.prepare("UPDATE source_incidence SET currency='closed' WHERE role='mention'").run();
}

it('does not certify a historical empty subject set when the close cannot be placed', async () => {
  recordedClose({});
  const result = await readClaimSubjects(
    { db: store.db, driver },
    {
      claimIds: ['claim'],
      context: checkedContext({ mode: asOf(QUESTION) }),
      budget: new RequestBudget(EVIDENCE_LIMITS),
    },
  );
  expect.soft(result.results.get('["id","claim"]')?.value).toEqual([]);
  expect.soft(result.results.get('["id","claim"]')?.evidence.status).toBe('incomplete');
  expect.soft(result.issues.some((issue) => issue.required)).toBe(true);
});

it('certifies exclusion when recorded proof places the world-time close before the question', async () => {
  recordedClose({ valid_until: CAPTURE.toISOString() });
  const result = await readClaimSubjects(
    { db: store.db, driver },
    {
      claimIds: ['claim'],
      context: checkedContext({ mode: asOf(QUESTION) }),
      budget: new RequestBudget(EVIDENCE_LIMITS),
    },
  );
  expect(result.results.get('["id","claim"]')).toMatchObject({
    value: [],
    evidence: { status: 'complete-for-use' },
  });
});

it('discloses uncertain durable mentions even when a resident source supplies a subject', async () => {
  recordedClose({});
  seedSource(store.db, {
    sourceId: 'resident-source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas Theta result' }] },
    turnIds: ['resident-turn'],
    now: CAPTURE,
  });
  for (const [nodeId, role] of [
    ['claim', 'extraction'],
    ['resident-entity', 'mention'],
  ] as const) {
    commitIncidence(store.db, {
      sourceId: 'resident-source',
      nodeId,
      role,
      operationId: `resident-${role}`,
      at: CAPTURE,
    });
  }
  establishScope(store.db, 'resident-source', 'sqlite:mention:out', CAPTURE);
  const knownSubject = {
    entityId: 'resident-entity',
    name: 'Atlas',
    nameNorm: 'atlas',
    sourceEpisodeId: 'resident-source',
  };
  // Only the resident source can contribute a row to the graph join.
  vi.spyOn(subjectGraph, 'findClaimSubjects').mockResolvedValue([knownSubject]);
  const result = await readClaimSubjects(
    { db: store.db, driver },
    {
      claimIds: ['claim'],
      context: checkedContext({ mode: asOf(QUESTION) }),
      budget: new RequestBudget(EVIDENCE_LIMITS),
    },
  );
  expect.soft(result.results.get('["id","claim"]')?.value).toEqual([knownSubject]);
  expect.soft(result.results.get('["id","claim"]')?.evidence.status).toBe('incomplete');
  expect
    .soft(result.issues.some((issue) => issue.required && issue.field === 'link_interval'))
    .toBe(true);
});

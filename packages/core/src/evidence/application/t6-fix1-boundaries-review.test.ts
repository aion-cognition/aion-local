import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { verifyEvidenceRevision } from './dependencies.js';
import { readItemMetadata } from './metadata.js';
import { asOf, knewAt } from '../../infrastructure/graph/read-modes.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { resolvedView } from '../../recall/application/resolved-view.js';
import { servedRecords, servedFingerprint } from '../../recall/domain/session-dedup.js';
import { item } from '../../recall/domain/test-support/pack.fixture.js';
import { RequestBudget, EVIDENCE_LIMITS } from '../domain/budget.js';
import { ownershipVerdict, OWNERSHIP_SCOPES } from '../domain/ownership.js';
import { durableRoleScope, SOURCE_STATE_SCOPE } from '../domain/scopes.js';
import {
  checkedContext,
  seedSource,
  commitIncidence,
  commitSourceState,
  establishScope,
} from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const MID = new Date('2026-09-08T12:00:00.000Z');
const LATER = new Date('2026-09-08T14:00:00.000Z');
const AFTER = new Date('2026-09-08T16:00:00.000Z');
let store: SqliteStore;
let dir: string;

function census(id: string): void {
  for (const { role, direction } of OWNERSHIP_SCOPES) {
    establishScope(store.db, id, durableRoleScope(role, direction), NOW);
  }
}
function closeMention(): void {
  commitSourceState(store.db, {
    sourceId: 'b',
    stateKind: 'unforgotten',
    operationId: 'close-b',
    at: LATER,
  });
  store.db
    .prepare(
      "INSERT INTO evidence_link_versions(link_id,version,prev_version,state,recorded_values_json,temporal_proof_json,observed_at,operation_key,operation_id,known_from,observed_ack_at) VALUES (?,2,1,'closed',?,'{}',?,'close-b','close-b',?,?)",
    )
    .run(
      'b:claim:mention',
      JSON.stringify({
        currency: 'closed',
        valid_until: LATER.toISOString(),
        tx_until: LATER.toISOString(),
      }),
      LATER.toISOString(),
      LATER.toISOString(),
      LATER.toISOString(),
    );
  store.db
    .prepare("UPDATE source_incidence SET currency='closed',link_version=2 WHERE source_id='b'")
    .run();
}
const graph = {
  executeQuery: async (query: string) => {
    if (query.includes('capture_ids')) {
      return { records: [{ toObject: () => ({ id: 'claim', capture_ids: ['a'] }) }] };
    }
    if (query.includes('AS parents')) {
      return {
        records: [
          {
            toObject: () => ({
              id: 'a',
              parents: [],
              unresolved: 0,
              narrated: false,
              citations: [],
              resolved_citations: 0,
            }),
          },
        ],
      };
    }
    return { records: [] };
  },
} as unknown as Driver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-ownership-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  for (const id of ['a', 'b']) {
    seedSource(store.db, {
      sourceId: id,
      sessionId: `session-${id}`,
      identity: 'review',
      content: { turns: [{ role: 'user', text: `Atlas ${id}` }] },
      turnIds: [`${id}-turn`],
      now: NOW,
    });
    establishScope(store.db, id, SOURCE_STATE_SCOPE, NOW);
    establishScope(store.db, id, 'sqlite:stated_derivation:out', NOW);
  }
  census('claim');
  census('a');
  census('a-turn');
  commitIncidence(store.db, {
    sourceId: 'a',
    nodeId: 'claim',
    role: 'extraction',
    operationId: 'extract-a',
    at: NOW,
  });
  commitIncidence(store.db, {
    sourceId: 'b',
    nodeId: 'claim',
    role: 'mention',
    operationId: 'mention-b',
    at: NOW,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function readAt(relationRows = EVIDENCE_LIMITS.relationRows, mode = {}) {
  return readItemMetadata(
    { db: store.db, driver: graph },
    {
      ids: ['claim'],
      context: checkedContext({ now: AFTER, mode }),
      budget: new RequestBudget({ ...EVIDENCE_LIMITS, relationRows }),
      maxRoots: 8,
    },
  );
}

it('does not record holdings from a real optional metadata budget gap', async () => {
  const reading = await readAt(0);
  expect(reading.issues.some((issue) => issue.reason === 'budget_limit')).toBe(true);
  const view = resolvedView({
    reading: { kind: 'resolved', ...reading },
    relatedClaims: new Map(),
    sessionId: 'session-a',
    attribute: true,
  });
  const candidate = item('claim');
  expect.soft(view.degraded.has('claim')).toBe(true);
  expect.soft(servedRecords(new Set(['claim']), new Map([['claim', candidate]]), view)).toEqual([]);
});

it('keeps the ample-budget metadata control recordable', async () => {
  const reading = await readAt();
  const view = resolvedView({
    reading: { kind: 'resolved', ...reading },
    relatedClaims: new Map(),
    sessionId: 'session-a',
    attribute: true,
  });
  const candidate = item('claim');
  expect(view.degraded.has('claim')).toBe(false);
  expect(servedRecords(new Set(['claim']), new Map([['claim', candidate]]), view)).toEqual([
    { itemId: 'claim', fingerprint: servedFingerprint(candidate, view.provenance.get('claim')) },
  ]);
});

it('does not validate old ownership after the source-state census changes its answer', async () => {
  seedSource(store.db, {
    sourceId: 'c',
    sessionId: 'session-c',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas c' }] },
    now: NOW,
  });
  commitIncidence(store.db, {
    sourceId: 'c',
    nodeId: 'claim',
    role: 'mention',
    operationId: 'mention-c',
    at: NOW,
  });
  const first = await readAt(undefined, knewAt(AFTER));
  const firstValue = first.results.get('["id","claim"]')?.value;
  expect(firstValue?.ownership.sessions).toEqual(['session-a', 'session-b']);
  expect(firstValue?.ownership.unknownAttribution).toBe(true);
  const revision = buildEvidenceRevision(first.dependencies);
  establishScope(store.db, 'c', SOURCE_STATE_SCOPE, NOW);
  const second = await readAt(undefined, knewAt(AFTER));
  expect(second.results.get('["id","claim"]')?.value?.ownership.sessions).toEqual([
    'session-a',
    'session-b',
    'session-c',
  ]);
  expect(verifyEvidenceRevision(store.db, revision).status).not.toBe('current');
});

it('preserves a candidate and discloses an optional unplaced ownership axis', async () => {
  closeMention();
  store.db
    .prepare(
      'UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=? AND version=2',
    )
    .run(JSON.stringify({ currency: 'closed' }), 'b:claim:mention');
  const reading = await readAt(undefined, asOf(MID));
  const value = reading.results.get('["id","claim"]')?.value;
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error('metadata absent');
  }
  expect(value.ownership.unknownAttribution).toBe(true);
  expect(ownershipVerdict(value.ownership, 'session-a')).toBe('unknown');
  expect(reading.issues).toContainEqual(
    expect.objectContaining({
      field: 'link_interval',
      reason: 'unsupported_history',
      historyReason: 'not_recorded',
      required: false,
    }),
  );
});

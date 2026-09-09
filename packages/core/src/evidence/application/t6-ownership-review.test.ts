import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { verifyEvidenceRevision } from './dependencies.js';
import { readItemMetadata } from './metadata.js';
import { ownershipIncidence, ownershipSummaryFor } from './ownership.js';
import { asOf, knewAt } from '../../infrastructure/graph/read-modes.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as sourceIdentity from '../../infrastructure/sqlite/source-identity.js';
import { RequestBudget, EVIDENCE_LIMITS } from '../domain/budget.js';
import { OWNERSHIP_SCOPES } from '../domain/ownership.js';
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
function summary(id: string, mode = {}) {
  const context = checkedContext({ mode, now: AFTER });
  return ownershipSummaryFor(store.db, id, ownershipIncidence(store.db, [id], context), context);
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

it('retains an owner at a world vantage before its recorded close', () => {
  closeMention();
  expect.soft(summary('claim', asOf(MID)).sessions).toEqual(['session-a', 'session-b']);
  expect.soft(summary('claim', asOf(AFTER)).sessions).toEqual(['session-a']);
  expect.soft(summary('claim', knewAt(MID)).sessions).toEqual(['session-a', 'session-b']);
  expect.soft(summary('claim', knewAt(AFTER)).sessions).toEqual(['session-a']);
});

it('honors a recorded world start for an ownership contribution', () => {
  store.db
    .prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?')
    .run(JSON.stringify({ currency: 'open', valid_from: LATER.toISOString() }), 'b:claim:mention');
  expect.soft(summary('claim', asOf(MID)).sessions).toEqual(['session-a']);
  expect.soft(summary('claim', asOf(AFTER)).sessions).toEqual(['session-a', 'session-b']);
});

it('attributes a turn through its source-part mapping', () => {
  expect(sourceIdentity.findSourcePartByTurnId(store.db, 'a-turn')?.sourceId).toBe('a');
  expect(summary('a-turn').sessions).toEqual(['session-a']);
});

it('applies suppression to a direct source contribution too', () => {
  expect(summary('a').sessions).toEqual(['session-a']);
  commitSourceState(store.db, {
    sourceId: 'a',
    stateKind: 'forgotten',
    operationId: 'forget-a',
    at: LATER,
  });
  expect(summary('a').sessions).toEqual([]);
});

it('invalidates the ownership revision when a mentioning source changes suppression', async () => {
  const read = (now = NOW) =>
    readItemMetadata(
      { db: store.db, driver: graph },
      {
        ids: ['claim'],
        context: checkedContext({ now }),
        budget: new RequestBudget(),
        maxRoots: 8,
      },
    );
  const before = await read();
  expect(before.results.get('["id","claim"]')?.value?.owningSessions).toEqual([
    'session-a',
    'session-b',
  ]);
  const revision = buildEvidenceRevision(before.dependencies);
  expect(verifyEvidenceRevision(store.db, revision).status).toBe('current');
  commitSourceState(store.db, {
    sourceId: 'b',
    stateKind: 'forgotten',
    operationId: 'forget-b',
    at: LATER,
  });
  expect((await read(AFTER)).results.get('["id","claim"]')?.value?.owningSessions).toEqual([
    'session-a',
  ]);
  expect(verifyEvidenceRevision(store.db, revision).status).toBe('stale');
});

it('does not perform per-owner source lookups after the ownership population exceeds its allowance', async () => {
  const lookups = vi.spyOn(sourceIdentity, 'readSourceRecord');
  const result = await readItemMetadata(
    { db: store.db, driver: graph },
    {
      ids: ['claim'],
      context: checkedContext(),
      budget: new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 0 }),
      maxRoots: 8,
    },
  );
  expect(result.results.get('["id","claim"]')?.value?.ownership.unknownAttribution).toBe(true);
  expect(lookups.mock.calls.filter((call) => call[1] === 'a' || call[1] === 'b')).toEqual([]);
});

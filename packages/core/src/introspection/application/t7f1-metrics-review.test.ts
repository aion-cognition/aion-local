import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  seedSource,
  commitIncidence,
  commitSourceState,
} from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  relatedIncidenceNodes,
  servedReferenceOutcome,
} from '../../infrastructure/sqlite/probe-incidence.js';
import {
  prepareMaterialization,
  acknowledgeMaterialization,
  type MaterializationWrite,
} from '../../reflection/application/legacy-records.js';

const START = new Date('2026-09-01T10:00:00.000Z');
const SERVED = new Date('2026-09-04T10:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-t7f1-metrics-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'needle' }] },
    turnIds: ['turn'],
    now: START,
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('does not credit incidence first acknowledged after the requested scoring vantage', () => {
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'item',
    role: 'mention',
    operationId: 'later',
    at: NOW,
  });
  expect.soft(relatedIncidenceNodes(store.db, 'source', ['item'], SERVED)).toEqual([]);
  expect(relatedIncidenceNodes(store.db, 'source', ['item'], NOW)).toEqual(['item']);
});

it('does not credit discovering a legacy reference as a later conversation reference', () => {
  const write: MaterializationWrite = {
    sourceId: 'source',
    operationId: 'legacy',
    scopes: [],
    observedAt: NOW,
    links: [
      {
        linkId: 'legacy-mention',
        kind: 'mention',
        qualifier: 'retained_node',
        fromId: 'source',
        toId: 'item',
        relationId: 'physical-old-edge',
        relationType: 'MENTIONS',
        incident: true,
        closed: false,
        clocks: { tx_from: START.toISOString() },
        recorded: {},
      },
    ],
  };
  store.db
    .transaction(() => {
      prepareMaterialization(store.db, write);
      commitSourceState(store.db, {
        sourceId: 'source',
        stateKind: 'unforgotten',
        operationId: 'legacy',
        at: NOW,
      });
      acknowledgeMaterialization(store.db, write, NOW.toISOString(), NOW.toISOString());
    })
    .immediate();
  expect(servedReferenceOutcome(store.db, 'item', SERVED.toISOString())).toBe('none');
});

it('still credits a genuine later accepted reference', () => {
  commitIncidence(store.db, {
    sourceId: 'source',
    nodeId: 'item',
    role: 'mention',
    operationId: 'later',
    at: NOW,
  });
  expect(servedReferenceOutcome(store.db, 'item', SERVED.toISOString())).toBe('referenced_after');
});

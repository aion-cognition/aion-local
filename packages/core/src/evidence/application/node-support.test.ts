import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { certifyNodeSupport, NODE_SUPPORT_SCOPES } from './node-support.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { DURABLE_ROLES, nodeRoleScope, NARRATIVE_SCOPES } from '../domain/scopes.js';
import { commitIncidence, establishScope } from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const NODE = 'node-1';

describe('node support', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-node-support-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Establishes the census for one scope, which is what lets an empty read mean absence. */
  function establish(scope: string): void {
    establishScope(store.db, NODE, scope, NOW);
  }

  it('answers unknown while any support scope is uncounted', () => {
    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({ support: 'unknown' });
  });

  it('answers unknown when every incidence census is established but the citation one is not', () => {
    for (const role of DURABLE_ROLES) {
      establish(nodeRoleScope(role));
    }

    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({
      support: 'unknown',
      reason: `no established census for ${NARRATIVE_SCOPES[0]}`,
    });
  });

  it('answers unsupported only once every census is established and empty', () => {
    for (const scope of NODE_SUPPORT_SCOPES) {
      establish(scope);
    }

    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({ support: 'unsupported' });
  });

  it('answers supported on an acknowledged confirmation, which is a source standing behind it', () => {
    commitIncidence(store.db, {
      sourceId: 'source-1',
      nodeId: NODE,
      role: 'stated_confirmation',
      operationId: 'operation-1',
      at: NOW,
    });
    for (const scope of NODE_SUPPORT_SCOPES) {
      establish(scope);
    }

    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({ support: 'supported' });
  });

  it('answers supported on a committed incidence, whatever the censuses say', () => {
    commitIncidence(store.db, {
      sourceId: 'source-1',
      nodeId: NODE,
      role: 'mention',
      operationId: 'operation-1',
      at: NOW,
    });

    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({
      support: 'supported',
      reason: 'committed mention incidence',
    });
  });

  it('carries the tokens the answer rests on, so a qualification can be void when one moves', () => {
    const reading = certifyNodeSupport(store.db, NODE);

    expect(Object.keys(reading.evidenceRevision).sort()).toEqual([...NODE_SUPPORT_SCOPES].sort());
    expect(reading.evidenceRevision[nodeRoleScope('mention')]).toBe('absent');

    establish(nodeRoleScope('mention'));
    expect(certifyNodeSupport(store.db, NODE).evidenceRevision[nodeRoleScope('mention')]).not.toBe(
      'absent',
    );
  });
});

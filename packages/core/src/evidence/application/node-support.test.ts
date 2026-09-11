import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { certifyNodeSupport, NODE_SUPPORT_SCOPES } from './node-support.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { scopeSupportsVerifiedEmpty } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  allocateNarrativeRevision,
  OVERVIEW_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
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

  /** A published revision that cites the node, recorded the way an acknowledgment records one. */
  function publishCitingRevision(): void {
    const allocated = allocateNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, 'window', NOW);
    publishNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, {
      familyKey: 'window',
      revisionNo: allocated.revisionNo,
      operationId: `publish-${allocated.nodeId}`,
      evidenceRevisionJson: '{}',
      knownFrom: NOW.toISOString(),
      observedAckAt: NOW.toISOString(),
      publishedAt: NOW,
    });
    store.db
      .prepare(
        'INSERT INTO revision_citations(narrative_node_id,target_id,target_kind) VALUES (?,?,?)',
      )
      .run(allocated.nodeId, NODE, 'retained_node');
  }

  it('answers unknown while any support scope is uncounted', () => {
    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({ support: 'unknown' });
  });

  it('settles on the incidence censuses alone, with no count of the citation scope', () => {
    for (const role of DURABLE_ROLES) {
      establish(nodeRoleScope(role));
    }

    // Nothing establishes the inbound citation census on an ordinary node, so requiring one held
    // every node at unknown for good. The citation records answer that half directly.
    expect(
      scopeSupportsVerifiedEmpty(store.db, {
        endpointId: NODE,
        relationClass: NARRATIVE_SCOPES[0],
      }),
    ).toBe(false);
    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({ support: 'unsupported' });
  });

  it('answers supported on a recorded citation while that census is still uncounted', () => {
    for (const role of DURABLE_ROLES) {
      establish(nodeRoleScope(role));
    }
    publishCitingRevision();

    expect(certifyNodeSupport(store.db, NODE)).toMatchObject({
      support: 'supported',
      reason: 'cited by a narrative revision',
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

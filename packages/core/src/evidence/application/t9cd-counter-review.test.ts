import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countCurrentMentionSources, countScope, openMentionRecency } from './logical-counters.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { commitSourceState } from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-09T04:00:00.000Z');
const NODE = 'entity-1';

/**
 * The counters are read off the committed records, so the fixture writes those records the way a
 * publication does: an intent, a link version bound to it, an incidence row pointing at the
 * version, and an acknowledgment. Nothing here counts a graph edge.
 */
describe('the logical counter populations', () => {
  let dir: string;
  let store: SqliteStore;
  let operations = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-logical-counters-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    operations = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function incidence(input: {
    readonly sourceId: string;
    readonly nodeId?: string;
    readonly role?: string;
    readonly currency?: 'open' | 'closed';
    readonly occurredAt?: string;
    readonly updatedAt?: string;
    readonly acknowledged?: boolean;
  }): void {
    operations += 1;
    const operationId = `op-${String(operations)}`;
    const nodeId = input.nodeId ?? NODE;
    const role = input.role ?? 'mention';
    const linkId = evidenceLinkId(role, 'retained_node', input.sourceId, nodeId);
    preparePublicationIntent(store.db, {
      operationId,
      kind: 'legacy_materialization',
      payloadDigest: 'digest',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: NOW,
    });
    recordSourceRecord(store.db, {
      sourceId: input.sourceId,
      sessionId: 'session-1',
      verificationStatus: 'pinned',
      verificationReason: 'fixture',
      occurredAt: input.occurredAt ?? NOW.toISOString(),
      createdAt: NOW,
    });
    store.db
      .prepare(
        `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
         VALUES (?, ?, 'retained_node', ?, ?, 'legacy_materialization', ?)
         ON CONFLICT (link_id) DO NOTHING`,
      )
      .run(linkId, role, input.sourceId, nodeId, NOW.toISOString());
    store.db
      .prepare(
        `INSERT INTO evidence_link_versions
           (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
            observed_at, operation_key, operation_id, known_from, observed_ack_at)
         VALUES (?, 1, NULL, 'materialized', ?, '{}', ?, ?, ?, ?, ?)`,
      )
      .run(
        linkId,
        JSON.stringify(input.updatedAt === undefined ? {} : { updated_at: input.updatedAt }),
        NOW.toISOString(),
        `key-${operationId}`,
        operationId,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    store.db
      .prepare(
        `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(input.sourceId, nodeId, role, input.currency ?? 'open', linkId);
    if (input.acknowledged !== false) {
      acknowledgePublicationIntent(store.db, {
        operationId,
        resultDigest: 'result',
        resultJson: '{}',
        observedAckAt: NOW,
      });
    }
  }

  function forget(sourceId: string): void {
    operations += 1;
    const operationId = `forget-${String(operations)}`;
    preparePublicationIntent(store.db, {
      operationId,
      kind: 'source_suppression',
      payloadDigest: 'digest',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: NOW,
    });
    store.db
      .prepare(
        `INSERT INTO source_state_versions
           (source_id, version, state_kind, operation_id, known_from, observed_at)
         VALUES (?, 1, 'forgotten', ?, ?, ?)`,
      )
      .run(sourceId, operationId, NOW.toISOString(), NOW.toISOString());
    acknowledgePublicationIntent(store.db, {
      operationId,
      resultDigest: 'result',
      resultJson: '{}',
      observedAckAt: NOW,
    });
  }

  function establish(nodeId: string, role: 'mention' | 'extraction'): void {
    operations += 1;
    const operationId = `seal-${String(operations)}`;
    const key = { endpointId: nodeId, relationClass: countScope(role) };
    prepareScopeAdvance(store.db, { ...key, operationId, updatedAt: NOW });
    acknowledgeScopeAdvance(store.db, {
      ...key,
      operationId,
      updatedAt: NOW,
      censusStatus: 'established',
    });
  }

  it('keeps forget and suppression histories independent in the current-source count', () => {
    incidence({ sourceId: 's' });
    establish(NODE, 'mention');
    forget('s');
    commitSourceState(store.db, {
      sourceId: 's',
      stateKind: 'unsuppressed',
      operationId: 'unsuppress',
      at: NOW,
    });
    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({
      status: 'counted',
      count: 0,
    });
  });
  it('preserves the seed population when the source is current but its mention edge is closed', () => {
    incidence({ sourceId: 's', currency: 'closed' });
    establish(NODE, 'mention');
    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({
      status: 'counted',
      count: 1,
    });
  });
  it('preserves identifier-decay open mentions even when their source is forgotten', () => {
    incidence({ sourceId: 's', updatedAt: NOW.toISOString() });
    establish(NODE, 'mention');
    forget('s');
    expect(openMentionRecency(store.db, NODE)).toMatchObject({
      status: 'counted',
      sources: 1,
      clockProved: true,
    });
  });
  it('does not use a world start as proof of a missing last-mention update', () => {
    incidence({ sourceId: 's' });
    establish(NODE, 'mention');
    store.db
      .prepare('UPDATE evidence_link_versions SET recorded_values_json=?')
      .run(JSON.stringify({ valid_from: NOW.toISOString() }));
    expect(openMentionRecency(store.db, NODE)).toMatchObject({
      status: 'counted',
      clockProved: false,
    });
  });
});

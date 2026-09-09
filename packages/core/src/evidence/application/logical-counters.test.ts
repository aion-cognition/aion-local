import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countCurrentMentionSources,
  countRecordedMentionSources,
  countRoleIncidence,
  countScope,
  entityPairSourceOverlap,
  openMentionRecency,
} from './logical-counters.js';
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

  it('refuses a count on an uncounted scope rather than answering zero', () => {
    incidence({ sourceId: 'source-1' });

    expect(countCurrentMentionSources(store.db, NODE)).toEqual({
      status: 'unavailable',
      reason: `no established census for sqlite:mention:in on ${NODE}`,
    });
  });

  it('answers a certified empty scope with zero', () => {
    establish(NODE, 'mention');

    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({
      status: 'counted',
      count: 0,
    });
  });

  it('counts one source once however many times it mentions the node', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1' });
    incidence({ sourceId: 'source-1', role: 'participation' });
    incidence({ sourceId: 'source-2' });

    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({ count: 2 });
  });

  it('leaves a prepared but unacknowledged mention out of every count', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1', acknowledged: false });

    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({ count: 0 });
  });

  it('drops a forgotten source from the current count and keeps it in the recorded one', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1' });
    incidence({ sourceId: 'source-2' });
    forget('source-2');

    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({ count: 1 });
    expect(countRecordedMentionSources(store.db, NODE)).toMatchObject({ count: 2 });
  });

  it('keeps a retired mention in the seed population and out of the decay one', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1', currency: 'closed', updatedAt: '2025-05-01T00:00:00.000Z' });

    // Edge currency is identifier decay's filter, not the seed population's. A source whose
    // mention edge was retired is still a source occurrence that mentions the entity.
    expect(countCurrentMentionSources(store.db, NODE)).toMatchObject({ count: 1 });
    expect(countRecordedMentionSources(store.db, NODE)).toMatchObject({ count: 1 });
    expect(openMentionRecency(store.db, NODE)).toMatchObject({ sources: 0 });
  });

  it('counts a role at the scope the registry keys it under', () => {
    incidence({ sourceId: 'source-1', role: 'extraction' });

    expect(countScope('extraction')).toBe('sqlite:extraction:out');
    expect(countRoleIncidence(store.db, NODE, 'extraction').status).toBe('unavailable');

    establish(NODE, 'extraction');

    expect(countRoleIncidence(store.db, NODE, 'extraction')).toMatchObject({ count: 1 });
  });

  it('refuses a pair overlap while either side is uncounted', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1' });
    incidence({ sourceId: 'source-1', nodeId: 'entity-2' });

    expect(entityPairSourceOverlap(store.db, NODE, 'entity-2')).toMatchObject({
      status: 'unavailable',
    });
  });

  it('measures the overlap and the smallest proved gap, and keeps undated sources apart', () => {
    establish(NODE, 'mention');
    establish('entity-2', 'mention');
    incidence({ sourceId: 'source-1', occurredAt: '2026-01-01T00:00:00.000Z' });
    incidence({
      sourceId: 'source-1',
      nodeId: 'entity-2',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    incidence({ sourceId: 'source-2', occurredAt: '2026-01-03T00:00:00.000Z' });

    const overlap = entityPairSourceOverlap(store.db, NODE, 'entity-2');
    expect(overlap).toMatchObject({
      status: 'counted',
      left: 2,
      right: 1,
      intersection: 1,
      union: 2,
      minimumGapMs: 0,
      undated: 0,
    });
  });

  it('ages a mention by the clock the record states, never by the acknowledgment', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1', updatedAt: '2025-05-01T00:00:00.000Z' });

    expect(openMentionRecency(store.db, NODE)).toEqual({
      status: 'counted',
      sources: 1,
      newestRecordedAt: '2025-05-01T00:00:00.000Z',
      clockProved: true,
    });
  });

  it('reports an unproved clock rather than letting a close run on a missing one', () => {
    establish(NODE, 'mention');
    incidence({ sourceId: 'source-1', updatedAt: '2025-05-01T00:00:00.000Z' });
    incidence({ sourceId: 'source-2' });

    expect(openMentionRecency(store.db, NODE)).toMatchObject({ sources: 2, clockProved: false });
  });
});

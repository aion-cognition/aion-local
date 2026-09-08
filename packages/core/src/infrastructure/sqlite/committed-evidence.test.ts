import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  committedIncidenceForNode,
  committedIncidenceForNodesAt,
  committedIncidenceForSource,
  committedLinkVersionAt,
  committedLinkVersions,
} from './committed-evidence.js';
import { SqliteStore } from './database.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
  settleUnacknowledgedIntent,
  type PublicationIntent,
} from './publication-intents.js';
import { committedSourceStates } from './source-states.js';

const EARLY = new Date('2026-09-08T01:00:00.000Z');
const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');

function intent(operationId: string): PublicationIntent {
  return {
    operationId,
    kind: 'intake',
    payloadDigest: 'digest',
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: EARLY,
  };
}

describe('the committed evidence view', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-committed-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    store.db
      .prepare(
        `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
         VALUES ('link-1', 'mention', 'subject', 'source-1', 'node-1', 'live_writer', ?)`,
      )
      .run(EARLY.toISOString());
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes a version the way a producer does: durable first, visible only at acknowledgment. */
  function prepareVersion(version: number, operationId: string, values: string): void {
    preparePublicationIntent(store.db, intent(operationId));
    store.db
      .prepare(
        `INSERT INTO evidence_link_versions
           (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
            observed_at, operation_key, operation_id)
         VALUES ('link-1', ?, ?, 'asserted', ?, '{}', ?, ?, ?)`,
      )
      .run(
        version,
        version === 1 ? null : version - 1,
        values,
        EARLY.toISOString(),
        `key-${version}`,
        operationId,
      );
  }

  function acknowledgeVersion(version: number, operationId: string, at: Date): void {
    acknowledgePublicationIntent(store.db, {
      operationId,
      resultDigest: 'result',
      resultJson: '{}',
      observedAckAt: at,
    });
    store.db
      .prepare(
        `UPDATE evidence_link_versions SET known_from = ?, observed_ack_at = ?
         WHERE link_id = 'link-1' AND version = ?`,
      )
      .run(at.toISOString(), at.toISOString(), version);
  }

  it('leaves a prepared version out until its operation is acknowledged', () => {
    prepareVersion(1, 'op-1', '{"weight":1}');

    expect(committedLinkVersions(store.db, 'link-1')).toEqual([]);

    acknowledgeVersion(1, 'op-1', NOW);

    expect(committedLinkVersions(store.db, 'link-1')).toMatchObject([
      { version: 1, operationId: 'op-1', knownFrom: NOW.toISOString() },
    ]);
  });

  it('removes nothing when a later operation is deferred', () => {
    prepareVersion(1, 'op-1', '{"weight":1}');
    acknowledgeVersion(1, 'op-1', NOW);
    prepareVersion(2, 'op-2', '{"weight":2}');
    settleUnacknowledgedIntent(store.db, 'op-2', 'deferred', 'store unavailable');

    expect(committedLinkVersions(store.db, 'link-1')).toMatchObject([{ version: 1 }]);
  });

  it('answers a question about a past moment from the chain, not from the newest version', () => {
    prepareVersion(1, 'op-1', '{"weight":1}');
    acknowledgeVersion(1, 'op-1', NOW);
    prepareVersion(2, 'op-2', '{"weight":2}');
    acknowledgeVersion(2, 'op-2', LATER);

    expect(committedLinkVersionAt(store.db, 'link-1', NOW)).toMatchObject({
      version: 1,
      recordedValuesJson: '{"weight":1}',
    });
    expect(committedLinkVersionAt(store.db, 'link-1', LATER)).toMatchObject({ version: 2 });
    // Nothing was visible before the first acknowledgment.
    expect(committedLinkVersionAt(store.db, 'link-1', EARLY)).toBeUndefined();
  });

  it('reads incidence from both sides once the owning version is acknowledged', () => {
    prepareVersion(1, 'op-1', '{"weight":1}');
    store.db
      .prepare(
        `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
         VALUES ('source-1', 'node-1', 'subject', 'open', 'link-1', 1)`,
      )
      .run();

    expect(committedIncidenceForSource(store.db, 'source-1')).toEqual([]);
    expect(committedIncidenceForNode(store.db, 'node-1')).toEqual([]);

    acknowledgeVersion(1, 'op-1', NOW);

    expect(committedIncidenceForSource(store.db, 'source-1')).toMatchObject([
      { nodeId: 'node-1', role: 'subject', currency: 'open' },
    ]);
    expect(committedIncidenceForNode(store.db, 'node-1', 'subject')).toMatchObject([
      { sourceId: 'source-1' },
    ]);
    expect(committedIncidenceForNode(store.db, 'node-1', 'object')).toEqual([]);
  });

  it('keeps a forget statement readable as its own committed history', () => {
    preparePublicationIntent(store.db, intent('forget-1'));
    store.db
      .prepare(
        `INSERT INTO source_state_versions
           (source_id, version, state_kind, operation_id, known_from, observed_at, detail_json)
         VALUES ('source-1', 1, 'forgotten', 'forget-1', NULL, ?, '{"reason":"requested"}')`,
      )
      .run(NOW.toISOString());

    expect(committedSourceStates(store.db, 'source-1')).toEqual([]);

    acknowledgePublicationIntent(store.db, {
      operationId: 'forget-1',
      resultDigest: 'result',
      resultJson: '{}',
      observedAckAt: NOW,
    });
    store.db
      .prepare("UPDATE source_state_versions SET known_from = ? WHERE source_id = 'source-1'")
      .run(NOW.toISOString());

    expect(committedSourceStates(store.db, 'source-1')).toMatchObject([
      { stateKind: 'forgotten', knownFrom: NOW.toISOString() },
    ]);
  });

  it('reads the old incidence version after the current projection advances', () => {
    prepareVersion(1, 'op-1', '{}');
    acknowledgeVersion(1, 'op-1', NOW);
    store.db
      .prepare(
        `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
         VALUES ('source-1', 'node-1', 'extraction', 'open', 'link-1', 1)`,
      )
      .run();
    prepareVersion(2, 'op-2', '{}');
    acknowledgeVersion(2, 'op-2', LATER);
    // The projection points at the newest version, which is what a read of "now" answers with.
    store.db.prepare("UPDATE source_incidence SET link_version = 2 WHERE link_id = 'link-1'").run();

    expect(
      committedIncidenceForNodesAt(store.db, ['node-1'], NOW, 'extraction').map(
        (row) => row.sourceId,
      ),
    ).toEqual(['source-1']);
  });
});

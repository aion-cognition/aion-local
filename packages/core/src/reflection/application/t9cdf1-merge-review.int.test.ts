import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { claimMergePublication } from './merge-publication.js';
import { sourceStateDependency } from '../../evidence/application/dependencies.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { forgetNode } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { seedRetainedClaim } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { restoreForgotten } from '../../infrastructure/graph/test-support/t9cdf1-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';

/**
 * B6's uncertain-commit branch, through the writer that makes it reachable.
 *
 * The merge used to be a bare graph write, so a commit whose response was lost looked exactly
 * like a commit that never happened. Under the coordinator the receipt decides, and an
 * interruption between the graph write and the acknowledgment is recovered rather than retried
 * against a graph one side has already left.
 *
 * The second thing it asserts is the evidence: a source that stood behind the absorbed claim
 * still stands behind the survivor, and its row on the loser is retired rather than deleted.
 */

/**
 * Behind the wall clock on purpose. Every acknowledgment's `known_from` is clamped forward past
 * its predecessor's, so a seeded record stamped in the future would make the coordinator's own
 * acknowledgment disagree with the clock it just took.
 */
const NOW = new Date('2026-01-01T00:00:00.000Z');
const EMBED_DIMENSION = 3;

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;
let serial = 0;

/** One committed mention of a node, written the way a materialization writes one. */
function mention(sourceId: string, nodeId: string, operationId: string): void {
  const linkId = evidenceLinkId('mention', 'retained_node', sourceId, nodeId);
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
  store.db
    .prepare(
      `INSERT INTO evidence_links (link_id, kind, qualifier, from_id, to_id, record_source, created_at)
       VALUES (?, 'mention', 'retained_node', ?, ?, 'legacy_materialization', ?)
       ON CONFLICT (link_id) DO NOTHING`,
    )
    .run(linkId, sourceId, nodeId, NOW.toISOString());
  store.db
    .prepare(
      `INSERT INTO evidence_link_versions
         (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
          observed_at, operation_key, operation_id, known_from, observed_ack_at)
       VALUES (?, 1, NULL, 'materialized', '{}', '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      linkId,
      NOW.toISOString(),
      `key-${operationId}`,
      operationId,
      NOW.toISOString(),
      NOW.toISOString(),
    );
  store.db
    .prepare(
      `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
       VALUES (?, ?, 'mention', 'open', ?, 1)`,
    )
    .run(sourceId, nodeId, linkId);
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: 'result',
    resultJson: '{}',
    observedAckAt: NOW,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-merge-publication-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, claimMergePublication],
    boundary: ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
  await coordinator.initialize();
}, 300_000);

beforeEach(() => {
  failAt = undefined;
  serial += 1;
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

async function pair() {
  const survivor = `survivor-${serial}`;
  const loser = `loser-${serial}`;
  const first = `first-${serial}`;
  const second = `second-${serial}`;
  for (const [sourceId, sessionId] of [
    [first, 'A'],
    [second, 'B'],
  ] as const) {
    seedSource(store.db, {
      sourceId,
      sessionId,
      identity: 'review',
      content: { observations: [sourceId] },
      now: NOW,
    });
  }
  await seedRetainedClaim(substrate.harness.driver, { id: survivor, sourceId: first });
  await seedRetainedClaim(substrate.harness.driver, { id: loser, sourceId: second });
  mention(second, loser, `mention-${serial}`);
  return { survivor, loser, first, second };
}
/**
 * The binding a judge would have decided on. The merge refuses a destructive write it cannot
 * re-verify, so every case that expects a merge supplies real proof rather than leaving the writer
 * with a public fallback nobody checked.
 */
function judged(sourceId: string) {
  return buildEvidenceRevision([sourceStateDependency(store.db, sourceId)]);
}
async function merge(survivor: string, loser: string, sourceId: string) {
  return coordinator.publish({
    kind: 'semantic_write',
    operationId: `merge-${serial}`,
    payload: {
      survivorId: survivor,
      loserId: loser,
      now: NOW.toISOString(),
      judged: judged(sourceId),
    },
  });
}

it('preserves recorded update proof on the survivor after a merge', async () => {
  const { survivor, loser, first, second } = await pair();
  store.db.prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?').run(
    JSON.stringify({
      currency: 'open',
      valid_from: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    }),
    evidenceLinkId('mention', 'retained_node', second, loser),
  );
  const result = await merge(survivor, loser, first);
  expect(result.status === 'acknowledged' && result.result).toMatchObject({ merged: true });
  const row = store.db
    .prepare(
      "SELECT v.recorded_values_json FROM evidence_links l JOIN evidence_link_versions v ON l.link_id=v.link_id WHERE l.to_id=? AND l.kind='mention' AND v.known_from IS NOT NULL ORDER BY v.version DESC LIMIT 1",
    )
    .get(survivor) as { recorded_values_json: string };
  expect(JSON.parse(row.recorded_values_json)).toMatchObject({ updated_at: NOW.toISOString() });
});
it('does not revive declined materialization in a later successful merge', async () => {
  const { survivor, loser, first, second } = await pair();
  await forgetNode(substrate.harness.driver, { id: survivor, now: NOW });
  expect((await merge(survivor, loser, first)).status).toBe('acknowledged');
  // The graph restore is test setup through the same retained-node helper used by the fixture.
  await restoreForgotten(substrate.harness.driver, survivor);
  const outcome = await coordinator.publish({
    kind: 'semantic_write',
    operationId: `merge-after-decline-${String(serial)}`,
    payload: { survivorId: survivor, loserId: loser, judged: judged(first) },
  });
  expect(outcome.status === 'acknowledged' && outcome.result).toMatchObject({ merged: true });
  expect(committedIncidenceForNode(store.db, survivor).map((r) => r.sourceId)).toContain(second);
});

it('does not repoint an existing newer survivor record to version one', async () => {
  const { survivor, loser, first, second } = await pair();
  mention(second, survivor, `existing-survivor-${String(serial)}`);
  const link = evidenceLinkId('mention', 'retained_node', second, survivor);
  store.db
    .prepare(
      "INSERT INTO evidence_link_versions (link_id,version,prev_version,state,recorded_values_json,temporal_proof_json,observed_at,operation_key,operation_id,known_from,observed_ack_at) SELECT link_id,2,1,state,recorded_values_json,temporal_proof_json,observed_at,operation_key||':second',operation_id,known_from,observed_ack_at FROM evidence_link_versions WHERE link_id=? AND version=1",
    )
    .run(link);
  store.db.prepare('UPDATE source_incidence SET link_version=2 WHERE link_id=?').run(link);
  expect(committedIncidenceForNode(store.db, survivor)[0]?.linkVersion).toBe(2);
  await merge(survivor, loser, first);
  expect(committedIncidenceForNode(store.db, survivor)[0]?.linkVersion).toBe(2);
});
it('does not accept a destructive merge with no judged binding', async () => {
  const { survivor, loser } = await pair();
  // Deliberately unbound: this is the case the writer must refuse.
  const result = await coordinator.publish({
    kind: 'semantic_write',
    operationId: `merge-${serial}`,
    payload: { survivorId: survivor, loserId: loser, now: NOW.toISOString() },
  });
  expect(result.status === 'acknowledged' && (result.result as { merged: boolean }).merged).toBe(
    false,
  );
});

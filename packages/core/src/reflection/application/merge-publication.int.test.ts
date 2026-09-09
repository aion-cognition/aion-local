import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { claimMergePublication } from './merge-publication.js';
import { sourceStateDependency } from '../../evidence/application/dependencies.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { seedRetainedClaim } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
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

/**
 * The binding the judge decided on. A merge destroys one of its two claims, so the write is
 * refused without proof a later reader can re-verify; every case that expects a merge to land
 * supplies real source-state proof rather than an absent one the guard cannot check.
 */
function judged(sourceId: string) {
  seedSource(store.db, {
    sourceId,
    sessionId: sourceId,
    identity: 'review',
    content: { observations: [sourceId] },
    now: NOW,
  });
  return buildEvidenceRevision([sourceStateDependency(store.db, sourceId)]);
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

it('carries the absorbed claim’s evidence to the survivor and retires its own rows', async () => {
  const survivor = `survivor-${String(serial)}`;
  const loser = `loser-${String(serial)}`;
  await seedRetainedClaim(substrate.harness.driver, { id: survivor, sourceId: 'episode-1' });
  await seedRetainedClaim(substrate.harness.driver, { id: loser, sourceId: 'episode-1' });
  mention('episode-1', loser, `seed-${String(serial)}`);

  const outcome = await coordinator.publish({
    kind: 'semantic_write',
    operationId: `merge-${String(serial)}`,
    payload: {
      survivorId: survivor,
      loserId: loser,
      now: NOW.toISOString(),
      judged: judged('episode-1'),
    },
  });

  expect(outcome.status).toBe('acknowledged');
  expect(outcome.status === 'acknowledged' && outcome.result).toMatchObject({ merged: true });
  // The source still stands behind something, and what it stands behind is the survivor.
  expect(committedIncidenceForNode(store.db, survivor, 'mention')).toMatchObject([
    { sourceId: 'episode-1', currency: 'open' },
  ]);
  // The loser's row is retired, not deleted: it is the record that the claim was there.
  expect(committedIncidenceForNode(store.db, loser, 'mention')).toMatchObject([
    { sourceId: 'episode-1', currency: 'closed' },
  ]);
}, 120_000);

it('recovers a merge interrupted between the graph write and the acknowledgment', async () => {
  const survivor = `survivor-crash-${String(serial)}`;
  const loser = `loser-crash-${String(serial)}`;
  await seedRetainedClaim(substrate.harness.driver, { id: survivor, sourceId: 'episode-2' });
  await seedRetainedClaim(substrate.harness.driver, { id: loser, sourceId: 'episode-2' });
  mention('episode-2', loser, `seed-crash-${String(serial)}`);

  failAt = 'before_ack';
  await expect(
    coordinator.publish({
      kind: 'semantic_write',
      operationId: `merge-crash-${String(serial)}`,
      payload: {
        survivorId: survivor,
        loserId: loser,
        now: NOW.toISOString(),
        judged: judged('episode-2'),
      },
    }),
  ).rejects.toThrow();

  // Nothing was carried and nothing was retired: the acknowledgment is where both happen.
  expect(committedIncidenceForNode(store.db, survivor, 'mention')).toEqual([]);
  expect(committedIncidenceForNode(store.db, loser, 'mention')).toMatchObject([
    { currency: 'open' },
  ]);

  const recovered = await coordinator.recover();

  expect(recovered?.status).toBe('acknowledged');
  expect(committedIncidenceForNode(store.db, survivor, 'mention')).toMatchObject([
    { sourceId: 'episode-2', currency: 'open' },
  ]);
  expect(committedIncidenceForNode(store.db, loser, 'mention')).toMatchObject([
    { currency: 'closed' },
  ]);
}, 120_000);

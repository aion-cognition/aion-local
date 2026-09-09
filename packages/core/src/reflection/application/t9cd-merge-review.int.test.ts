import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { claimMergePublication } from './merge-publication.js';
import { sourceStateDependency } from '../../evidence/application/dependencies.js';
import { ownershipIncidence, ownershipSummaryFor } from '../../evidence/application/ownership.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  checkedContext,
  seedSource,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { forgetNode } from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  projectOwnershipSummary,
  OWNERSHIP_PROPERTIES,
} from '../../infrastructure/graph/ownership-summary-queries.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  nodeProperties,
  seedRetainedClaim,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import {
  committedIncidenceForNodesAt,
  committedIncidenceForNode,
} from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
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
async function merge(survivor: string, loser: string) {
  return coordinator.publish({
    kind: 'semantic_write',
    operationId: `merge-${serial}`,
    payload: {
      survivorId: survivor,
      loserId: loser,
      now: NOW.toISOString(),
      // What the decision was taken on. A merge destroys one of its two claims, and the writer
      // refuses one it cannot re-verify: an empty dependency set proves nothing about either.
      judged: buildEvidenceRevision([sourceStateDependency(store.db, `first-${serial}`)]),
    },
  });
}
it('leaves durable evidence unchanged when the graph declines the merge', async () => {
  const { survivor, loser } = await pair();
  await forgetNode(substrate.harness.driver, { id: survivor, now: NOW });
  const before = committedIncidenceForNode(store.db, survivor);
  const result = await merge(survivor, loser);
  expect(result.status === 'acknowledged' && result.result).toMatchObject({ merged: false });
  expect(committedIncidenceForNode(store.db, survivor)).toEqual(before);
});
it('preserves original incidence clocks and records the loser retirement in its version chain', async () => {
  const { survivor, loser, second } = await pair();
  store.db.prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?').run(
    JSON.stringify({
      currency: 'open',
      valid_from: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    }),
    evidenceLinkId('mention', 'retained_node', second, loser),
  );
  const result = await merge(survivor, loser);
  expect(result.status === 'acknowledged' && result.result).toMatchObject({ merged: true });
  expect
    .soft(committedIncidenceForNodesAt(store.db, [survivor], undefined)[0]?.validFrom)
    .toBe(NOW.toISOString());
  expect
    .soft(committedIncidenceForNodesAt(store.db, [loser], undefined)[0]?.currency)
    .toBe('closed');
});
it('updates the trusted ownership projection when a merge adds another owning session', async () => {
  const { survivor, loser, first } = await pair();
  mention(first, survivor, `survivor-mention-${serial}`);
  for (const { role, direction } of OWNERSHIP_SCOPES) {
    establishScope(store.db, survivor, durableRoleScope(role, direction), NOW);
  }
  const pairing = readSubstratePairing(store.db);
  if (pairing === undefined) {
    throw new Error('unpaired fixture');
  }
  await inWriteTransaction(substrate.harness.driver, (tx) =>
    projectOwnershipSummary(tx, {
      nodeId: survivor,
      sessions: ['A'],
      unknownAttribution: false,
      censusEstablished: true,
      evidenceVersion: 'before',
      sequence: pairing.lastAckSequence,
      substrateId: pairing.substrateId,
    }),
  );
  expect(
    (await nodeProperties(substrate.harness.driver, survivor))[OWNERSHIP_PROPERTIES.sessions],
  ).toEqual(['A']);
  const result = await merge(survivor, loser);
  expect(result.status === 'acknowledged' && result.result).toMatchObject({ merged: true });
  const context = checkedContext();
  expect(
    ownershipSummaryFor(
      store.db,
      survivor,
      ownershipIncidence(store.db, [survivor], context),
      context,
    ).sessions,
  ).toEqual(['A', 'B']);
  expect(
    (await nodeProperties(substrate.harness.driver, survivor))[OWNERSHIP_PROPERTIES.sessions],
  ).toEqual(['A', 'B']);
});

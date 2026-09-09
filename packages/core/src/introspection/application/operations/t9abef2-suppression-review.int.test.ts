import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { orphanSuppressionPublication } from './orphan-suppression.js';
import {
  readRelationScope,
  verifyEvidenceRevision,
} from '../../../evidence/application/dependencies.js';
import {
  establishNodeState,
  establishNodeSupportScopes,
} from '../../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { readOrphanCensus } from '../orphan-census.js';

const EARLY = new Date('2026-01-01T00:00:00.000Z');
const CHECK = new Date('2026-09-01T00:00:00.000Z');
let sub: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-suppression-boundary-'));
  sub = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: sub.sqlitePath });
  await runGraphMigrations(sub.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: sub.harness.driver,
    db: store.db,
    logger: openLogger({ filePath: join(dir, 'test.log'), level: 'fatal' }),
    handlers: [...PUBLICATION_HANDLERS, orphanSuppressionPublication],
  });
  await coordinator.initialize();
}, 120000);
afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(sub);
  rmSync(dir, { recursive: true, force: true });
});
it.each(['changed', 'missing'])(
  'refuses a %s node-state proof after qualification',
  async (kind) => {
    const id = `state-${kind}`;
    await writeStampedNode(sub.harness.driver, {
      label: 'Insight',
      id,
      now: EARLY,
      properties: { text: id },
    });
    establishNodeSupportScopes(store.db, id, EARLY);
    establishNodeState(store.db, id, { revision: 1, at: EARLY });
    await readOrphanCensus(
      { driver: sub.harness.driver, db: store.db },
      { limit: 10, now: EARLY, forgetAfterDays: 30, policyRevision: 0 },
    );
    if (kind === 'changed') {
      establishNodeState(store.db, id, { revision: 2, at: CHECK });
    } else {
      store.db
        .prepare(
          "DELETE FROM evidence_scope_mirrors WHERE endpoint_id=? AND relation_class='graph.node_state'",
        )
        .run(id);
    }
    const outcome = await coordinator.publish({
      kind: 'topology_update',
      operationId: `suppress-${kind}`,
      payload: { nodeId: id, policyRevision: 0, forgetBefore: '2026-08-01T00:00:00.000Z' },
    });
    expect.soft(outcome.status).toBe('deferred');
    expect((await nodeProperties(sub.harness.driver, id)).forgotten_at).toBeUndefined();
  },
);

it('invalidates node-state evidence when its suppression is acknowledged', async () => {
  const id = 'new-suppression';
  await writeStampedNode(sub.harness.driver, {
    label: 'Insight',
    id,
    now: EARLY,
    properties: { text: id },
  });
  establishNodeSupportScopes(store.db, id, EARLY);
  establishNodeState(store.db, id, { revision: 1, at: EARLY });
  await readOrphanCensus(
    { driver: sub.harness.driver, db: store.db },
    { limit: 10, now: EARLY, forgetAfterDays: 30, policyRevision: 0 },
  );
  const scope = readRelationScope(store.db, {
    kind: 'node',
    endpointId: id,
    scope: 'graph.node_state',
    empty: false,
  });
  if (scope.status !== 'verified') {
    throw new Error('fixture did not establish node state');
  }
  const revision = buildEvidenceRevision([scope.dependency]);
  expect(verifyEvidenceRevision(store.db, revision).status).toBe('current');
  const outcome = await coordinator.publish({
    kind: 'topology_update',
    operationId: 'suppression-invalidation',
    payload: { nodeId: id, policyRevision: 0, forgetBefore: '2026-08-01T00:00:00.000Z' },
  });
  expect(
    outcome.status === 'acknowledged' && (outcome.result as { suppressed: boolean }).suppressed,
  ).toBe(true);
  expect(verifyEvidenceRevision(store.db, revision).status).not.toBe('current');
});

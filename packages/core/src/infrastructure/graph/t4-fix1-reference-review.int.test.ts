import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { bootstrapBackbone } from './backbone.js';
import { runGraphMigrations } from './migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { intakePublication } from '../../reflection/application/intake-publication.js';
import { projectionRebuildPublication } from '../../reflection/application/rebuild-publication.js';
import { statedReferencesPublication } from '../../reflection/application/reference-publication.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import { SqliteStore } from '../sqlite/database.js';
import { listStatedLinks } from '../sqlite/evidence-links.js';
import { listReferenceBatches } from '../sqlite/source-identity.js';
import { transitionSourceResidency } from '../sqlite/source-lifecycle.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let skipRecovery = false;

function content(marker: string): ReflectionContent {
  return {
    turns: [{ role: 'user', text: `a turn about ${marker}` }],
    observations: [`an observation about ${marker}`],
  };
}

async function acceptSource(marker: string): Promise<string> {
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-${marker}`,
    payload: {
      identity: 'member-1',
      sessionId,
      payloadJson: JSON.stringify(content(marker)),
      referencesJson: null,
      lane: null,
      originJson: null,
      pipelineVersion: PIPELINE_VERSION,
      occurredAt: NOW.toISOString(),
      indexPolicy: 'archive-v1',
      readiness: null,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error(`intake ${marker} was not accepted`);
  }
  return (outcome.result as { sourceId: string }).sourceId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-reference-publication-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const sessions = new SessionManager(substrate.harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  ({ sessionId } = await sessions.ensureSession({ identity: 'transport-1', now: NOW }));
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [
      ...PUBLICATION_HANDLERS,
      intakePublication,
      statedReferencesPublication,
      projectionRebuildPublication,
    ],
    now: () => NOW,
  });
  await coordinator.initialize();
}, 120_000);

afterEach(async () => {
  if (!skipRecovery) {
    await coordinator.recover();
  }
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

function intakePayload(
  marker: string,
  occurredAt = NOW.toISOString(),
  referencesJson: string | null = null,
) {
  return {
    identity: 'member-1',
    sessionId,
    payloadJson: JSON.stringify(content(marker)),
    referencesJson,
    lane: null,
    originJson: null,
    pipelineVersion: PIPELINE_VERSION,
    occurredAt,
    indexPolicy: 'archive-v1',
    readiness: null,
  };
}

it('projects references before reuse intake acknowledges their settlement', async () => {
  const marker = 'reused-with-reference';
  const source = await acceptSource(marker);
  const target = await acceptSource(`${marker}-target`);
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `repeat-${marker}`,
    payload: intakePayload(marker, NOW.toISOString(), JSON.stringify({ derived_from: [target] })),
  });
  expect(outcome.status).toBe('acknowledged');
  const edges = await substrate.harness.driver.executeQuery(
    'MATCH (a:AionNode {id:$source})-[r:DERIVES_FROM]->(b:AionNode {id:$target}) RETURN count(r) AS n',
    { source, target },
  );
  expect(edges.records[0]?.get('n').toNumber()).toBe(1);
});

it('refuses rebuild when proof has been explicitly downgraded', async () => {
  const source = await acceptSource('pinned-proof');
  const ids = [
    source,
    ...(
      store.db
        .prepare("SELECT turn_id FROM source_parts WHERE source_id=? AND part_kind='turn'")
        .all(source) as { turn_id: string }[]
    ).map((p) => p.turn_id),
  ];
  transitionSourceResidency(store.db, {
    sourceId: source,
    state: 'evicted',
    operationId: 'evict-pinned',
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery(
    'UNWIND $ids AS id MATCH (n:AionNode {id:id}) SET n.id="retired:"+id REMOVE n:AionNode',
    { ids },
  );
  store.db
    .prepare(
      "UPDATE source_records SET verification_status='pinned', verification_reason='proof withdrawn' WHERE source_id=?",
    )
    .run(source);
  const result = await coordinator.publish({
    kind: 'projection_rebuild',
    operationId: 'rebuild-pinned',
    payload: { sourceId: source, observedAt: NOW.toISOString() },
  });
  expect(result.status).not.toBe('acknowledged');
});

it('accepts references on a new source without wedging the acknowledgment slot', async () => {
  const target = await acceptSource('new-reference-target');
  skipRecovery = true;
  const result = await coordinator
    .publish({
      kind: 'intake',
      operationId: 'new-with-reference',
      payload: intakePayload(
        'new-with-reference',
        NOW.toISOString(),
        JSON.stringify({ derived_from: [target] }),
      ),
    })
    .catch((error: unknown) => error);
  expect.soft(result).toMatchObject({ status: 'acknowledged' });
  expect.soft(coordinator.hasPending()).toBe(false);
});

it('accepts every statement kind a new source carries, once', async () => {
  skipRecovery = false;
  const derived = await acceptSource('kinds-derived');
  const corrected = await acceptSource('kinds-corrected');
  const confirmed = 'claim-kinds';
  await substrate.harness.driver.executeQuery('CREATE (:AionNode:Memory:Claim {id:$id})', {
    id: confirmed,
  });
  const references = JSON.stringify({
    derived_from: [derived],
    supersedes: [corrected],
    confirmations: [
      {
        target: confirmed,
        by: 'reviewer',
        evidence: 'the receipt',
        occurred_at: NOW.toISOString(),
      },
    ],
  });
  const request = {
    kind: 'intake' as const,
    operationId: 'new-every-kind',
    payload: intakePayload('new-every-kind', NOW.toISOString(), references),
  };

  const outcome = await coordinator.publish(request);

  expect(outcome.status).toBe('acknowledged');
  const source = (outcome as unknown as { result: { sourceId: string } }).result.sourceId;
  expect(
    listStatedLinks(store.db, source)
      .map((link) => link.kind)
      .sort(),
  ).toEqual(['confirms', 'corrects', 'derived_from']);
  expect(listStatedLinks(store.db, source).every((link) => link.knownFrom !== null)).toBe(true);
  expect(listReferenceBatches(store.db, source)).toHaveLength(1);
  const events = (): number =>
    (
      store.db
        .prepare("SELECT count(*) AS n FROM usage_events WHERE kind = 'memory_confirmed'")
        .get() as { n: number }
    ).n;
  const after = events();

  // A no-change retry of the same delivery repeats nothing.
  expect(await coordinator.publish(request)).toEqual(outcome);
  expect(listReferenceBatches(store.db, source)).toHaveLength(1);
  expect(listStatedLinks(store.db, source)).toHaveLength(3);
  expect(events()).toBe(after);
});

it('recovers a new source with references that crashed before its acknowledgment', async () => {
  skipRecovery = false;
  const target = await acceptSource('crash-reference-target');
  let interrupt = true;
  const interrupted = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, intakePublication, statedReferencesPublication],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === 'before_ack' && interrupt) {
        interrupt = false;
        throw new Error('interrupted before acknowledgment');
      }
    },
  });
  await interrupted.initialize();
  const request = {
    kind: 'intake' as const,
    operationId: 'crash-with-reference',
    payload: intakePayload(
      'crash-with-reference',
      NOW.toISOString(),
      JSON.stringify({ derived_from: [target] }),
    ),
  };

  await expect(interrupted.publish(request)).rejects.toThrow();
  expect(interrupted.hasPending()).toBe(true);

  const recovered = await interrupted.recover();

  expect(recovered).toMatchObject({ status: 'acknowledged' });
  expect(interrupted.hasPending()).toBe(false);
  const source = (recovered as unknown as { result: { sourceId: string } }).result.sourceId;
  expect(listReferenceBatches(store.db, source)).toHaveLength(1);
  expect(listStatedLinks(store.db, source)).toMatchObject([{ kind: 'derived_from', version: 1 }]);
  const edges = await substrate.harness.driver.executeQuery(
    'MATCH (:AionNode {id:$source})-[r:DERIVES_FROM]->(:AionNode {id:$target}) RETURN count(r) AS n',
    { source, target },
  );
  expect(edges.records[0]?.get('n').toNumber()).toBe(1);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { applyMergeWithRecovery } from '../../evidence/application/merge-recovery.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PublicationPendingError } from '../../infrastructure/publication/errors.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { intakePublication } from '../../reflection/application/intake-publication.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import { SessionManager } from '../../session/session-manager.js';
import { publicationRecord } from '../sqlite/publication-coordinator-store.js';
import { transitionSourceResidency } from '../sqlite/source-lifecycle.js';

/**
 * The resolver against the stores it actually reads: a source accepted through the publication
 * coordinator, resolved back out of the archive, fenced on the dependency set it cited, and one
 * merge whose commit nobody observed settled through the coordinator's own receipt.
 */

const NOW = new Date('2026-09-08T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let sessionId: string;
let failAt: PublicationBoundary | undefined;

function content(marker: string): ReflectionContent {
  return {
    turns: [
      { role: 'user', text: `the migration took 45 seconds ${marker}` },
      { role: 'assistant', text: `recorded, 45 seconds ${marker}` },
    ],
    observations: [`the runbook was out of date ${marker}`],
  };
}

function payload(marker: string): Record<string, unknown> {
  return {
    identity: 'member-1',
    sessionId,
    payloadJson: JSON.stringify(content(marker)),
    referencesJson: null,
    lane: null,
    originJson: JSON.stringify({ channel: 'mcp' }),
    pipelineVersion: PIPELINE_VERSION,
    occurredAt: NOW.toISOString(),
    indexPolicy: 'archive-v1',
    readiness: { policyRevision: 1, stageNames: ['entities'] },
  };
}

async function accept(marker: string): Promise<string> {
  const outcome = await coordinator.publish({
    kind: 'intake',
    operationId: `intake-${marker}`,
    payload: payload(marker),
  });
  if (outcome.status !== 'acknowledged') {
    throw new Error(`intake ${marker} was ${outcome.status}`);
  }
  return (outcome.result as { sourceId: string }).sourceId;
}

function resolver(options: { readonly certified: boolean }): EvidenceResolver {
  return new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    ...(options.certified ? { publications: coordinator } : {}),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-evidence-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
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
    handlers: [...PUBLICATION_HANDLERS, intakePublication],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted intake');
      }
    },
  });
  await coordinator.initialize();
}, 120_000);

afterEach(async () => {
  failAt = undefined;
  await coordinator.recover();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('keeps a claim rooted in its durable source after the raw projection leaves the graph', async () => {
  const sourceId = await accept('metadata-evicted');
  const claimId = 'claim-metadata-evicted';
  await substrate.harness.driver.executeQuery(
    'CREATE (n:AionNode:Memory:Claim {id:$id, source_episode_id:$source})',
    { id: claimId, source: sourceId },
  );
  commitIncidence(store.db, {
    sourceId,
    nodeId: claimId,
    role: 'extraction',
    operationId: 'metadata-extraction',
    at: NOW,
  });
  establishScope(store.db, claimId, durableRoleScope('extraction', 'out'), NOW);
  establishScope(store.db, sourceId, durableRoleScope('stated_derivation', 'out'), NOW);
  const reader = resolver({ certified: false });
  const before = await reader.resolveMetadata([claimId], checkedContext(), { maxRoots: 4 });
  expect(before.results.get(JSON.stringify(['id', claimId]))?.value?.provenance.roots).toEqual([
    sourceId,
  ]);
  transitionSourceResidency(store.db, {
    sourceId,
    state: 'evicted',
    operationId: 'evict-metadata',
    transitionedAt: NOW,
  });
  await substrate.harness.driver.executeQuery(
    'MATCH (n:Episode {id:$id}) SET n.id="retired:"+n.id REMOVE n:AionNode:Memory:Episode',
    { id: sourceId },
  );
  const after = await reader.resolveMetadata([claimId], checkedContext(), { maxRoots: 4 });
  expect(after.results.get(JSON.stringify(['id', claimId]))?.value?.provenance.roots).toEqual([
    sourceId,
  ]);
});
it('recognizes its acknowledged operation when another actor recovered it first', async () => {
  const operationId = 'intake-recovered-elsewhere';
  failAt = 'before_ack';
  await expect(
    coordinator.publish({ kind: 'intake', operationId, payload: payload('recovered-elsewhere') }),
  ).rejects.toThrow();
  await coordinator.recover();
  expect(publicationRecord(store.db, operationId)?.state).toBe('acknowledged');
  const outcome = await applyMergeWithRecovery({
    operationId,
    attempt: async () => {
      throw new PublicationPendingError(operationId, new Error('response lost'));
    },
    coordinator,
    logger,
  });
  expect(outcome.status).toBe('settled');
});

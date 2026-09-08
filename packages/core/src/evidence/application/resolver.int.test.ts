import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMergeWithRecovery } from './merge-recovery.js';
import { EvidenceResolver } from './resolver.js';
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
import { idAddress } from '../domain/address.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishScope,
} from '../test-support/evidence.fixture.js';

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
let serial = 0;

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

describe('evidence against the real stores', () => {
  it('resolves an accepted source out of the archive it was verified against', async () => {
    serial += 1;
    const marker = `accepted-${String(serial)}`;
    const sourceId = await accept(marker);

    const batch = await resolver({ certified: true }).resolveSources(
      [idAddress(sourceId)],
      checkedContext(),
      'raw_inspection',
    );
    const result = batch.results.get(`["id","${sourceId}"]`);

    expect(result?.evidence.status).toBe('complete-for-use');
    expect(result?.coverage.status).toBe('supported');
    expect(result?.residency).toBe('resident');
    expect(result?.value?.text).toContain(`the migration took 45 seconds ${marker}`);
    expect(result?.value?.parts).toHaveLength(3);
    expect(batch.revision.dependencies.map((dependency) => dependency.scope)).toEqual([
      'source.content',
      'source.parts',
      'source.references',
      'source.state',
    ]);
  });

  it('refuses the revision it cited once the source has been forgotten', async () => {
    serial += 1;
    const marker = `fenced-${String(serial)}`;
    const sourceId = await accept(marker);
    const reader = resolver({ certified: true });
    const batch = await reader.resolveSources(
      [idAddress(sourceId)],
      checkedContext(),
      'raw_inspection',
    );

    expect(reader.confirm(batch.revision)).toEqual({ status: 'current' });

    commitSourceState(store.db, {
      sourceId,
      stateKind: 'forgotten',
      operationId: `forget-${marker}`,
      at: NOW,
    });
    const check = reader.confirm(batch.revision);

    expect(check.status).toBe('stale');
    expect(check.status === 'stale' ? check.changed.map((entry) => entry.scope) : []).toEqual([
      'source.state',
    ]);
  });

  it('abstains from a judgment whose required source has been forgotten', async () => {
    serial += 1;
    const marker = `abstain-${String(serial)}`;
    const sourceId = await accept(marker);
    const claimId = `claim-${marker}`;
    commitIncidence(store.db, {
      sourceId,
      nodeId: claimId,
      role: 'extraction',
      operationId: `extract-${marker}`,
      at: NOW,
    });
    establishScope(store.db, claimId, durableRoleScope('extraction', 'out'), NOW);
    commitSourceState(store.db, {
      sourceId,
      stateKind: 'forgotten',
      operationId: `forget-${marker}`,
      at: NOW,
    });

    const assembly = await resolver({ certified: true }).assembleJudgment(
      {
        route: 'claim_dedup',
        reservedUnits: 0,
        use: 'claim_judgment',
        sides: [
          { nodeId: claimId, statement: 'the migration took 45 seconds' },
          { nodeId: claimId, statement: 'the migration took 5 seconds' },
        ],
      },
      checkedContext(),
    );

    expect(assembly).toMatchObject({ status: 'abstained', reason: 'required_source_suppressed' });
    expect(assembly.status === 'abstained' ? assembly.addresses : []).toEqual([
      { kind: 'id', id: sourceId },
      { kind: 'id', id: sourceId },
    ]);
  });

  it('degrades a read under a publication the coordinator is holding', async () => {
    serial += 1;
    const marker = `pending-${String(serial)}`;
    const sourceId = await accept(`resident-${marker}`);
    failAt = 'before_ack';
    await expect(
      coordinator.publish({
        kind: 'intake',
        operationId: `intake-${marker}`,
        payload: payload(marker),
      }),
    ).rejects.toThrow();

    const batch = await resolver({ certified: true }).resolveSources(
      [idAddress(sourceId)],
      checkedContext(),
      'raw_inspection',
    );
    const result = batch.results.get(`["id","${sourceId}"]`);

    expect(result?.value?.text).toContain('the migration took 45 seconds');
    expect(batch.issues.map((issue) => issue.reason)).toContain('pending_publication');
  });

  it('settles a merge whose commit nobody observed through the coordinator receipt', async () => {
    serial += 1;
    const marker = `uncertain-${String(serial)}`;
    const operationId = `intake-${marker}`;
    failAt = 'before_ack';
    await expect(
      coordinator.publish({ kind: 'intake', operationId, payload: payload(marker) }),
    ).rejects.toThrow();
    expect(coordinator.hasPending()).toBe(true);

    const outcome = await applyMergeWithRecovery({
      operationId,
      attempt: () =>
        Promise.reject(new PublicationPendingError(operationId, new Error('response lost'))),
      coordinator,
      logger,
    });

    expect(outcome).toEqual({ status: 'settled', operationId });
    expect(coordinator.hasPending()).toBe(false);
  });
});

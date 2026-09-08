import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyMergeWithRecovery } from './merge-recovery.js';
import { EvidenceResolver } from './resolver.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  retireEpisodeProjection,
  seedRetainedClaim,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PublicationPendingError } from '../../infrastructure/publication/errors.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { publicationRecord } from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { intakePublication } from '../../reflection/application/intake-publication.js';
import { statedReferencesPublication } from '../../reflection/application/reference-publication.js';
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
    handlers: [...PUBLICATION_HANDLERS, intakePublication, statedReferencesPublication],
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
    establishScope(store.db, claimId, durableRoleScope('stated_correction', 'in'), NOW);
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

    expect(outcome).toMatchObject({ status: 'settled', operationId });
    // The receipt says an operation landed. Its own result is what says what landed.
    expect(outcome.status === 'settled' ? outcome.result : undefined).toMatchObject({
      created: true,
    });
    expect(coordinator.hasPending()).toBe(false);
  });

  it('keeps a claim rooted in its durable source after the raw projection leaves the graph', async () => {
    serial += 1;
    const marker = `metadata-evicted-${String(serial)}`;
    const sourceId = await accept(marker);
    const claimId = `claim-${marker}`;
    await seedRetainedClaim(substrate.harness.driver, { id: claimId, sourceId });
    commitIncidence(store.db, {
      sourceId,
      nodeId: claimId,
      role: 'extraction',
      operationId: `metadata-extraction-${marker}`,
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
      operationId: `evict-${marker}`,
      transitionedAt: NOW,
    });
    await retireEpisodeProjection(substrate.harness.driver, sourceId);
    const after = await reader.resolveMetadata([claimId], checkedContext(), { maxRoots: 4 });

    expect(after.results.get(JSON.stringify(['id', claimId]))?.value?.provenance.roots).toEqual([
      sourceId,
    ]);
  });

  it('recognizes its acknowledged operation when another actor recovered it first', async () => {
    serial += 1;
    const operationId = `intake-recovered-elsewhere-${String(serial)}`;
    failAt = 'before_ack';
    await expect(
      coordinator.publish({
        kind: 'intake',
        operationId,
        payload: payload(`recovered-elsewhere-${String(serial)}`),
      }),
    ).rejects.toThrow();
    // Another actor gets to the pending publication first, which leaves an empty slot and a
    // receipt that only the record can report.
    await coordinator.recover();

    expect(publicationRecord(store.db, operationId)?.state).toBe('acknowledged');

    const outcome = await applyMergeWithRecovery({
      operationId,
      attempt: () =>
        Promise.reject(new PublicationPendingError(operationId, new Error('response lost'))),
      coordinator,
      logger,
    });

    expect(outcome.status).toBe('settled');
  });

  it('reads a valid prepared operation as unsettled rather than a protocol invariant', async () => {
    serial += 1;
    const operationId = `valid-prepared-outcome-${String(serial)}`;
    failAt = 'prepared';
    await expect(
      coordinator.publish({ kind: 'intake', operationId, payload: payload(operationId) }),
    ).rejects.toThrow();

    expect(publicationRecord(store.db, operationId)?.state).toBe('prepared');

    const value = ((): unknown => {
      try {
        return coordinator.outcomeOf(operationId);
      } catch (error) {
        return error;
      }
    })();

    expect(value).toBeUndefined();
    expect(coordinator.hasPending()).toBe(true);

    await coordinator.recover();

    expect(coordinator.outcomeOf(operationId)?.status).toBe('acknowledged');
  });

  it('preserves the actual terminal root through a derived source and its relocation', async () => {
    serial += 1;
    const marker = String(serial);
    const parent = await accept(`original-root-${marker}`);
    const echo = await accept(`derived-echo-${marker}`);
    const claim = `claim-derived-echo-${marker}`;
    await coordinator.publish({
      kind: 'stated_references',
      operationId: `derive-echo-${marker}`,
      payload: {
        sourceId: echo,
        supersedes: [],
        derivedFrom: [parent],
        confirmations: [],
        deliveryKey: `derive-echo-${marker}`,
        observedAt: NOW.toISOString(),
      },
    });
    await seedRetainedClaim(substrate.harness.driver, { id: claim, sourceId: echo });
    commitIncidence(store.db, {
      sourceId: echo,
      nodeId: claim,
      role: 'extraction',
      operationId: `extract-echo-${marker}`,
      at: NOW,
    });
    establishScope(store.db, claim, durableRoleScope('extraction', 'out'), NOW);
    for (const sourceId of [echo, parent]) {
      establishScope(store.db, sourceId, durableRoleScope('stated_derivation', 'out'), NOW);
    }
    const graph = await fetchClaimProvenance(substrate.harness.driver, {
      ids: [claim],
      maxRoots: 4,
      mode: {},
    });

    expect(graph.get(claim)?.roots).toEqual([parent]);

    const reader = resolver({ certified: false });
    const before = await reader.resolveMetadata([claim], checkedContext(), { maxRoots: 4 });

    expect(before.results.get(JSON.stringify(['id', claim]))?.value?.provenance.roots).toEqual([
      parent,
    ]);

    await retireEpisodeProjection(substrate.harness.driver, echo);
    transitionSourceResidency(store.db, {
      sourceId: echo,
      state: 'evicted',
      operationId: `relocate-echo-${marker}`,
      transitionedAt: NOW,
    });
    const after = await reader.resolveMetadata([claim], checkedContext(), { maxRoots: 4 });

    expect(after.results.get(JSON.stringify(['id', claim]))?.value?.provenance.roots).toEqual([
      parent,
    ]);
  });

  it('walks through a retained parent after the raw source projection is absent', async () => {
    serial += 1;
    const marker = String(serial);
    const root = await accept(`mixed-root-${marker}`);
    const origin = await accept(`mixed-origin-${marker}`);
    const parentNode = `mixed-parent-${marker}`;
    const childNode = `mixed-child-${marker}`;
    await seedRetainedClaim(substrate.harness.driver, { id: parentNode, sourceId: root });
    await seedRetainedClaim(substrate.harness.driver, { id: childNode, sourceId: origin });
    for (const [sourceId, nodeId] of [
      [root, parentNode],
      [origin, childNode],
    ]) {
      commitIncidence(store.db, {
        sourceId: sourceId!,
        nodeId: nodeId!,
        role: 'extraction',
        operationId: `extract-${nodeId!}`,
        at: NOW,
      });
      establishScope(store.db, nodeId!, durableRoleScope('extraction', 'out'), NOW);
    }
    // The derivation names the retained claim, not its capture: this is the step a source-only
    // walk cannot cross.
    await coordinator.publish({
      kind: 'stated_references',
      operationId: `mixed-derive-${marker}`,
      payload: {
        sourceId: origin,
        supersedes: [],
        derivedFrom: [parentNode],
        confirmations: [],
        deliveryKey: `mixed-derive-${marker}`,
        observedAt: NOW.toISOString(),
      },
    });
    for (const id of [root, origin]) {
      establishScope(store.db, id, durableRoleScope('stated_derivation', 'out'), NOW);
    }
    expect(
      (
        await fetchClaimProvenance(substrate.harness.driver, {
          ids: [childNode],
          maxRoots: 4,
          mode: {},
        })
      ).get(childNode)?.roots,
    ).toEqual([root]);

    await retireEpisodeProjection(substrate.harness.driver, origin);
    const result = await resolver({ certified: false }).resolveMetadata(
      [childNode],
      checkedContext(),
      { maxRoots: 4 },
    );

    expect(result.results.get(JSON.stringify(['id', childNode]))?.value?.provenance.roots).toEqual([
      root,
    ]);
  });
});

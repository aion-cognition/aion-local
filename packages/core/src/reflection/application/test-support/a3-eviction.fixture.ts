import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import { establishScope } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { inWriteTransaction } from '../../../infrastructure/graph/connection.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { markInventoryComplete } from '../../../infrastructure/sqlite/generation-lifecycle.js';
import {
  completeSourceWork,
  readActiveGeneration,
} from '../../../infrastructure/sqlite/processing-generations.js';
import { readSourceRecord } from '../../../infrastructure/sqlite/source-identity.js';
import { readGenerationWork } from '../../../infrastructure/sqlite/source-readiness.js';
import { runSourceIndexJob } from '../../../introspection/application/source-index.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { ChunkBoundaryPolicy } from '../../domain/chunk-boundary.js';
import { publishChunkNarrative, sealSessionChunk } from '../chunk-narrative.js';
import type { ChunkNarrativeDeps } from '../chunk-seal.js';
import { durableEligibility, type EvictionCandidate } from '../eviction-eligibility.js';
import { planRemoval, type PlannedRemoval } from '../eviction-plan.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { publishPipelineReadinessPolicy } from '../readiness.js';
import {
  sourceSuppressionOperationId,
  sourceSuppressionPublication,
} from '../source-suppression.js';

/**
 * A substrate the eviction battery may actually delete from.
 *
 * Every store here is thrown away with the file: a temporary SQLite path and a leased Neo4j
 * container the harness clears, so the only data any case removes is data this fixture wrote a
 * moment earlier. Nothing reaches a live checkout or a live database, and nothing in the battery
 * has a path to one.
 *
 * Getting a source to the point where it MAY be evicted is most of the work, and it is done
 * through the production paths rather than by writing the end state: real intake, a real seal, a
 * real chunk publication, the readiness rows a finished pipeline leaves, and the real indexing
 * job. A fixture that wrote "eligible" directly would be testing the fence against its own
 * opinion of what eligible means.
 */

export const NOW = new Date('2026-09-11T06:00:00.000Z');
export let store: SqliteStore;
export let driver: Driver;
export let publications: PublicationCoordinator;
export let chunks: ChunkNarrativeDeps;
let intake: ReflectionIntakeDeps;
let substrate: RehearsalSubstrate;
let dir: string;
let failAt: { boundary: PublicationBoundary; match: string } | undefined;
let hookAt: { boundary: PublicationBoundary; match: string; run: () => Promise<void> } | undefined;

/** Interrupts one publication at one boundary, so recovery has something to finish. */
export function interruptAt(boundary: PublicationBoundary, match = ''): void {
  failAt = { boundary, match };
}

/** Runs once at one boundary, so the substrate can be moved underneath a held guard. */
export function atBoundary(
  boundary: PublicationBoundary,
  run: () => Promise<void>,
  match = '',
): void {
  hookAt = { boundary, match, run };
}

const scripted: Provider = {
  embed: () => {
    throw new Error('no embedding');
  },
  generate: (request: StructuredRequest) => {
    expect(store.db.inTransaction).toBe(false);
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    return Promise.resolve({
      sentences: [...user.matchAll(/\[(S\d+)\]/g)].map((match) => ({
        text: `the source ${match[1]} was recorded`,
        source_ids: [match[1]],
      })),
    });
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-a3-eviction-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  ({ driver } = substrate.harness);
  await runGraphMigrations(driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(driver, { memberName: 'eviction review' });
  const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  publications = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
    boundary: async ({ boundary, operationId }) => {
      if (failAt?.boundary === boundary && operationId.includes(failAt.match)) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
      if (hookAt?.boundary === boundary && operationId.includes(hookAt.match)) {
        const { run } = hookAt;
        hookAt = undefined;
        await run();
      }
    },
  });
  await publications.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    [{ name: 'entities', run: () => Promise.resolve({ status: 'ok', summary: '' }) }],
    NOW,
  );
  intake = {
    driver,
    db: store.db,
    sessions: new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    publications,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
  chunks = {
    driver,
    db: store.db,
    provider: scripted,
    publications,
    logger,
    resolver: new EvidenceResolver({ driver, db: store.db, logger, publications }),
  };
}, 180_000);

beforeEach(() => {
  failAt = undefined;
  hookAt = undefined;
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

/** The incoming-statement census an accepted source would have carried from a live producer. */
function census(sourceId: string): void {
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, sourceId, durableRoleScope(role, 'in'), NOW);
  }
  establishScope(store.db, sourceId, durableRoleScope('stated_derivation', 'out'), NOW);
}

export async function acceptEpisode(
  identity: string,
  marker: string,
  /** How long the body is. A member over the rendered-input allowance seals as a coverage gap. */
  sentences = 8,
): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [`${marker}: ${'the project keeps its source evidence. '.repeat(sentences)}`] },
    { identity, now: NOW },
  );
  census(result.episode_id);
  return result.episode_id;
}

/** A source with real Turn projections, which is what makes a removal set more than one node. */
export async function acceptConversation(identity: string, marker: string): Promise<string> {
  const result = await handleReflection(
    intake,
    {
      turns: [
        { role: 'user', text: `${marker}: what did the project decide about its evidence?` },
        { role: 'assistant', text: `${marker}: the project keeps every source it accepted.` },
      ],
    },
    { identity, now: NOW },
  );
  census(result.episode_id);
  return result.episode_id;
}

export function sessionOf(sourceId: string): string {
  const record = readSourceRecord(store.db, sourceId);
  if (record === undefined) {
    throw new Error('source missing');
  }
  return record.sessionId;
}

export async function sealAndPublish(
  sourceId: string,
  policy?: ChunkBoundaryPolicy,
): Promise<string> {
  const sealed = await sealSessionChunk(chunks, sessionOf(sourceId), {
    now: NOW,
    sessionClosing: true,
    ...(policy === undefined ? {} : { policy }),
  });
  expect(sealed.status).toBe('sealed');
  if (sealed.status !== 'sealed') {
    throw new Error('fixture did not seal');
  }
  await republishChunk(sealed.chunkId, policy);
  return sealed.chunkId;
}

/**
 * A second revision over frozen membership, which is how a coverage gap reaches a published head.
 * The gaps are computed when the narrative is written, so a member suppressed after the first
 * revision only shows up in the next one.
 */
export async function republishChunk(chunkId: string, policy?: ChunkBoundaryPolicy): Promise<void> {
  const published = await publishChunkNarrative(chunks, chunkId, {
    now: NOW,
    ...(policy === undefined ? {} : { policy }),
  });
  expect(published.status).toBe('published');
}

/** The operator's forget, through the writer that owns it, so the state is committed not written. */
export async function forgetSource(sourceId: string): Promise<void> {
  const outcome = await publications.publish({
    kind: sourceSuppressionPublication.kind,
    operationId: sourceSuppressionOperationId('forget', sourceId, NOW),
    payload: { act: 'forget', nodeId: sourceId, observedAt: NOW.toISOString() },
  });
  expect(outcome.status).toBe('acknowledged');
}

/** The readiness rows a finished pipeline leaves: every stage settled, the inventory closed. */
export function finishReadiness(sourceId: string): void {
  const generation = readActiveGeneration(store.db, sourceId);
  if (generation === undefined) {
    throw new Error(`source ${sourceId} has no active generation`);
  }
  for (const work of readGenerationWork(store.db, sourceId, generation.processingGeneration)) {
    if (!['completed', 'obsolete'].includes(work.state)) {
      completeSourceWork(
        store.db,
        work.workId,
        { outcome: 'complete', reason: 'fixture_pipeline_finished' },
        NOW,
      );
    }
  }
  markInventoryComplete(store.db, sourceId, generation.processingGeneration, true);
}

export async function indexSource(sourceId: string): Promise<void> {
  const outcome = await runSourceIndexJob(
    {
      db: store.db,
      resolver: chunks.resolver,
      now: () => NOW,
      logger: { warn: () => undefined, debug: () => undefined },
    },
    { sourceId },
  );
  expect(outcome.status).toBe('indexed');
}

export async function activateCoverage(): Promise<void> {
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  const outcome = await publications.publish({
    kind: 'coverage_activation',
    operationId: 'a3-coverage-activation',
    payload: {
      expectedEpoch: readCurrentCoverageContract(store.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
  expect(outcome.status).toBe('acknowledged');
}

/** The withdrawal, through the same writer, so what it re-owes is what production re-owes. */
export async function unforgetSource(sourceId: string): Promise<void> {
  const outcome = await publications.publish({
    kind: sourceSuppressionPublication.kind,
    operationId: sourceSuppressionOperationId('unforget', sourceId, NOW),
    payload: { act: 'unforget', nodeId: sourceId, observedAt: NOW.toISOString() },
  });
  expect(outcome.status).toBe('acknowledged');
}

/** One source carried all the way to eligible through the production paths. */
export async function eligibleSource(
  identity: string,
  marker: string,
  conversation = false,
): Promise<string> {
  const sourceId = conversation
    ? await acceptConversation(identity, marker)
    : await acceptEpisode(identity, marker);
  await sealAndPublish(sourceId);
  finishReadiness(sourceId);
  await indexSource(sourceId);
  return sourceId;
}

/**
 * Where a second process reaches this substrate.
 *
 * A real file in WAL mode and a real container, both this file's own. Nothing here is shared with
 * anything outside the run, which is what makes handing the address to a forked child safe.
 */
export function substrateAddress(): {
  readonly uri: string;
  readonly password: string;
  readonly sqlitePath: string;
  readonly isolated: boolean;
} {
  return {
    uri: substrate.harness.uri,
    password: substrate.harness.password,
    sqlitePath: substrate.sqlitePath,
    isolated: substrate.verdict.status === 'isolated' && substrate.sqlitePath !== ':memory:',
  };
}

export type EvictionNomination = {
  readonly candidate: EvictionCandidate;
  readonly plan: PlannedRemoval;
};

/** The removal set derived outside the guard, which is what an attempt binds and the guard rechecks. */
export async function nominateEviction(
  sourceId: string,
  policy: { readonly now: Date; readonly minAgeMs: number },
): Promise<EvictionNomination> {
  const verdict = durableEligibility(store.db, sourceId, policy);
  if (verdict.status !== 'eligible') {
    throw new Error(`fixture source is not eligible: ${verdict.reason}`);
  }
  const planned = await inWriteTransaction(driver, (tx) =>
    planRemoval(store.db, tx, verdict.candidate),
  );
  if (planned.status !== 'planned') {
    throw new Error(`fixture source could not be planned: ${planned.reason}`);
  }
  return { candidate: verdict.candidate, plan: planned.plan };
}

/**
 * The payload one attempt binds. Every durable version travels with it, because the guard compares
 * what the run READ against what it finds and a field left out is a field nothing can compare on.
 */
export function evictionPayload(nomination: EvictionNomination): Record<string, unknown> {
  const { candidate, plan } = nomination;
  return {
    sourceId: candidate.sourceId,
    sessionId: candidate.sessionId,
    observedAt: NOW.toISOString(),
    coverageEpoch: candidate.coverageEpoch,
    chunkId: candidate.chunkId,
    publishedRevisionNo: candidate.publishedRevisionNo,
    processingGeneration: candidate.processingGeneration,
    operationalRevision: candidate.operationalRevision,
    readinessPolicyRevision: candidate.readinessPolicyRevision,
    projectionGeneration: candidate.projectionGeneration,
    acceptedReferenceVersion: candidate.acceptedReferenceVersion,
    qualifiedAt: candidate.qualifiedAt,
    nodeIds: [...plan.nodeIds],
    relationIds: [...plan.relationIds],
    nodeDigest: plan.nodeDigest,
    categoryDigest: plan.categoryDigest,
    survivors: plan.survivors.map((entry) => ({ ...entry })),
    contentDigests: { ...candidate.contentDigests },
    searchCoverageProof: { ...candidate.searchCoverageProof },
    dependencies: candidate.dependencies.map((entry) => ({ ...entry })),
  };
}

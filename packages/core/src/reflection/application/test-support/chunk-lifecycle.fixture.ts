import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import {
  commitSourceState,
  establishScope,
} from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { renameNodeId } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../../infrastructure/publication/types.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { prepareRetirementVersion } from '../../../infrastructure/sqlite/evidence-link-materialization.js';
import {
  acknowledgeStatedLinkVersions,
  listStatedLinksTo,
} from '../../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../../infrastructure/sqlite/publication-intents.js';
import { readSourceRecord } from '../../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../../session/session-manager.js';
import { sealSessionChunk, type ChunkNarrativeDeps } from '../chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { publishPipelineReadinessPolicy } from '../readiness.js';

/**
 * The harness the C2 steady-state batteries share: real stores, a real coordinator, a real
 * intake, and a scripted synthesis provider that records the exact string it was handed.
 *
 * The provider is scripted and it records the exact string it was handed, so every claim about
 * what reached the model is asserted on that string rather than on a coverage number. Nothing in
 * this file's import graph constructs a model client: the intake provider rejects both calls, so
 * an accidental generation fails the run instead of passing quietly.
 */

export const NOW = new Date('2026-09-09T06:00:00.000Z');
export const EMBED_DIMENSION = 3;
export const STAGES = ['entities'];

let substrate: RehearsalSubstrate;
let dir: string;
export let driver: Driver;
export let store: SqliteStore;
export let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
export let chunks: ChunkNarrativeDeps;

/** Every user message the scripted provider was handed, in order. */
export let prompts: string[] = [];

/** Empties the recorded prompts mid-case, for an assertion about one attempt's own input. */
export function resetPrompts(): void {
  prompts = [];
}
/** The chunk the first case sealed, which the second case asks about again. */
export const battery = { basicChunkId: '' };
/** The boundary this run interrupts once, for the crash-recovery case. */
let failAt: PublicationBoundary | undefined;
/** A projection this run moves out of reach once, after the check and before the graph write. */
let hideAtPrepared: string | undefined;

function citeEveryHandle(prompt: string): unknown {
  const handles = [...prompt.matchAll(/\[(S\d+)\]/g)].map((match) => match[1] ?? '');
  return {
    sentences: handles.map((handle) => ({
      text: `the substrate recorded what ${handle} carried`,
      source_ids: [handle],
    })),
  };
}

/** What this run does while the model is being asked, for the cases about that window. */
let duringGeneration: (() => void) | undefined;

export function whileGenerating(hook: () => void): void {
  duringGeneration = hook;
}

/** Interrupts the next publication at one boundary, once. */
export function scheduleFailure(boundary: PublicationBoundary): void {
  failAt = boundary;
}

/** Moves one projection out of reach after the check and before the graph write, once. */
export function scheduleHide(sourceId: string): void {
  hideAtPrepared = sourceId;
}

const scripted: Provider = {
  embed: () => Promise.reject(new Error('no embedding in this battery')),
  generate: (request: StructuredRequest) => {
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    prompts.push(user);
    const hook = duringGeneration;
    duringGeneration = undefined;
    hook?.();
    return Promise.resolve(citeEveryHandle(user));
  },
};

/** Long enough that the sentence budget can carry one sentence per member. */
export function body(marker: string): string {
  return `${marker}: ${'the sync keyed on id_slug rather than on npi. '.repeat(9)}`;
}

export async function accept(session: string, marker: string): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [body(marker)] },
    { identity: session, now: NOW },
  );
  // Every accepted source gets its incoming-statement census, which is what a cohort seal
  // establishes at scale and what a publication now requires: a revision resting on an uncounted
  // "nothing corrects this" is one no correction could ever invalidate.
  establishStatementCensus(result.episode_id);
  return result.episode_id;
}

export function sessionNodeOf(sourceId: string): string {
  const record = readSourceRecord(store.db, sourceId);
  if (record === undefined) {
    throw new Error(`${sourceId} has no source record`);
  }
  return record.sessionId;
}

/**
 * A correction, accepted the way a caller states one: an ordinary push carrying provenance, so
 * the link and its version are committed through the real acceptance publication rather than
 * written beside it.
 */
export async function acceptCorrection(
  session: string,
  marker: string,
  target: string,
): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [body(marker)], provenance: { supersedes: [target] } },
    { identity: session, now: NOW },
  );
  establishStatementCensus(result.episode_id);
  // Counting the corrected source's scope again is what moves its published token, which is how a
  // revision that rested on "nothing corrects this" finds out that something now does.
  establishStatementCensus(target);
  return result.episode_id;
}

/** Retires a standing statement the way a withdrawal would, under an acknowledged operation. */
export function retireCorrection(fromSource: string, toSource: string, operationId: string): void {
  // Found by its record rather than recomputed: the acceptance chose the target class, and a
  // retirement that guessed it would close a link nobody ever wrote.
  const link = listStatedLinksTo(store.db, toSource).find(
    (row) => row.kind === 'corrects' && row.fromId === fromSource,
  );
  if (link === undefined) {
    throw new Error(`no committed correction from ${fromSource} to ${toSource}`);
  }
  prepareRetirementVersion(store.db, {
    linkId: link.linkId,
    operationId,
    operationKey: `${operationId}:retire`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
  });
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'stated_references',
    payloadDigest: operationId,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: `result:${operationId}`,
    resultJson: '{}',
    observedAckAt: NOW,
  });
  acknowledgeStatedLinkVersions(store.db, operationId, NOW.toISOString(), NOW.toISOString());
  establishStatementCensus(toSource);
}

/** The incoming-statement census for a source, which is what the cohort seal establishes at scale. */
export function establishStatementCensus(sourceId: string): void {
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, sourceId, durableRoleScope(role, 'in'), NOW);
  }
  // The outbound derivation population too, which is what a lineage walk asks a source about
  // before it will call the chain ended there.
  establishScope(store.db, sourceId, durableRoleScope('stated_derivation', 'out'), NOW);
}

export function forget(sourceId: string, operationId: string): void {
  commitSourceState(store.db, { sourceId, stateKind: 'forgotten', operationId, at: NOW });
}

export function unforget(sourceId: string, operationId: string): void {
  commitSourceState(store.db, { sourceId, stateKind: 'unforgotten', operationId, at: NOW });
}

export async function sealAndPublish(session: string): Promise<string> {
  const sealed = await sealSessionChunk(chunks, session, { now: NOW, sessionClosing: true });
  if (sealed.status !== 'sealed') {
    throw new Error(`expected a seal, got ${sealed.status}`);
  }
  return sealed.chunkId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-chunk-narrative-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  ({ driver } = substrate.harness);
  await runGraphMigrations(driver, store.db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(driver, { memberName: 'member' });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: async ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === 'prepared' && hideAtPrepared !== undefined) {
        const target = hideAtPrepared;
        hideAtPrepared = undefined;
        await renameNodeId(driver, target, `${target}-hidden`);
      }
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
  await coordinator.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    STAGES.map((name) => ({ name, run: () => Promise.resolve({ status: 'ok', summary: '' }) })),
    NOW,
  );
  intake = {
    driver,
    db: store.db,
    sessions: new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('no generation in this battery')),
    },
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };
  chunks = {
    driver,
    db: store.db,
    provider: scripted,
    resolver: new EvidenceResolver({
      driver,
      db: store.db,
      logger,
      publications: coordinator,
    }),
    publications: coordinator,
    logger,
  };
}, 300_000);

beforeEach(() => {
  prompts = [];
  failAt = undefined;
  hideAtPrepared = undefined;
  duringGeneration = undefined;
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

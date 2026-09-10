import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import {
  commitSourceState,
  dropScope,
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
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { ChunkBoundaryPolicy } from '../../domain/chunk-boundary.js';
import { INCOMING_STATEMENT_SCOPES } from '../chunk-evidence.js';
import { sealSessionChunk, type ChunkNarrativeDeps } from '../chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { publishPipelineReadinessPolicy } from '../readiness.js';

export const NOW = new Date('2026-09-09T06:00:00.000Z');
export let store: SqliteStore;
export let driver: Driver;
export let publications: PublicationCoordinator;
export let chunks: ChunkNarrativeDeps;
export let prompts: string[] = [];
let intake: ReflectionIntakeDeps;
let substrate: RehearsalSubstrate;
let dir: string;
let generationHook: ((request: StructuredRequest) => unknown) | undefined;

export function onGenerate(hook: (request: StructuredRequest) => unknown): void {
  generationHook = hook;
}

const scripted: Provider = {
  embed: async () => {
    throw new Error('no embedding');
  },
  generate: async (request) => {
    expect(store.db.inTransaction).toBe(false);
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    prompts.push(user);
    const result = await generationHook?.(request);
    if (result !== undefined) {
      return result;
    }
    return {
      sentences: [...user.matchAll(/\[(S\d+)\]/g)].map((match) => ({
        text: `the source ${match[1]} was recorded`,
        source_ids: [match[1]],
      })),
    };
  },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-t10b-review-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  ({ driver } = substrate.harness);
  await runGraphMigrations(driver, store.db, { embedDimension: 3 });
  const backbone = await bootstrapBackbone(driver, { memberName: 'chunk review' });
  const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  publications = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
  });
  await publications.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    [{ name: 'entities', run: async () => ({ status: 'ok', summary: '' }) }],
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
      embed: async () => {
        throw new Error('no embedding');
      },
      generate: async () => {
        throw new Error('no generation at intake');
      },
    },
    publications,
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
    publications,
    logger,
    resolver: new EvidenceResolver({ driver, db: store.db, logger, publications }),
  };
}, 180_000);

beforeEach(() => {
  generationHook = undefined;
  prompts = [];
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

export function census(sourceId: string): void {
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, sourceId, durableRoleScope(role, 'in'), NOW);
  }
  establishScope(store.db, sourceId, durableRoleScope('stated_derivation', 'out'), NOW);
}

/**
 * A source whose incoming-statement census nobody established.
 *
 * The acceptance writer counts those populations for every source it mints, so this is the state
 * of a source accepted before that producer existed — which is the population the migration cohort
 * covers, and the only remaining way an ordinary member reads as uncounted.
 */
export function dropCensus(sourceId: string): void {
  for (const scope of INCOMING_STATEMENT_SCOPES) {
    dropScope(store.db, sourceId, scope);
  }
}

export async function acceptSource(
  identity: string,
  marker: string,
  counted = true,
  occurredAt?: Date,
): Promise<string> {
  const result = await handleReflection(
    intake,
    {
      observations: [`${marker}: ${'the project keeps its source evidence. '.repeat(8)}`],
    },
    { identity, now: occurredAt ?? NOW },
  );
  if (counted) {
    census(result.episode_id);
  }
  return result.episode_id;
}

export async function acceptCorrection(
  identity: string,
  marker: string,
  target: string,
): Promise<string> {
  const result = await handleReflection(
    intake,
    {
      observations: [`${marker}: ${'the prior statement needs this correction. '.repeat(8)}`],
      provenance: { supersedes: [target] },
    },
    { identity, now: NOW },
  );
  census(result.episode_id);
  return result.episode_id;
}

export function sessionOf(sourceId: string): string {
  const source = readSourceRecord(store.db, sourceId);
  if (source === undefined) {
    throw new Error('source missing');
  }
  return source.sessionId;
}

export async function sealFor(sourceId: string, policy?: ChunkBoundaryPolicy): Promise<string> {
  const outcome = await sealSessionChunk(chunks, sessionOf(sourceId), {
    now: NOW,
    sessionClosing: true,
    ...(policy === undefined ? {} : { policy }),
  });
  expect(outcome.status).toBe('sealed');
  if (outcome.status !== 'sealed') {
    throw new Error('fixture did not seal');
  }
  return outcome.chunkId;
}

export function forgetSource(sourceId: string, key: string): void {
  commitSourceState(store.db, { sourceId, stateKind: 'forgotten', operationId: key, at: NOW });
}

export async function activateCoverage(): Promise<void> {
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  await publications.publish({
    kind: 'coverage_activation',
    operationId: 'review-coverage-activation',
    payload: {
      expectedEpoch: readCurrentCoverageContract(store.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
}

export async function acceptTurn(
  identity: string,
  text: string,
  occurredAt: Date,
): Promise<string> {
  const result = await handleReflection(
    intake,
    {
      turns: [{ role: 'user', text, occurred_at: occurredAt.toISOString() }],
    },
    { identity, now: NOW },
  );
  census(result.episode_id);
  return result.episode_id;
}

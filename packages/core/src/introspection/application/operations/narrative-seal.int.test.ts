import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { narrativeSealOperation, type SealScales } from './narrative-seal.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { durableRoleScope } from '../../../evidence/domain/scopes.js';
import { establishScope } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../../infrastructure/publication/types.js';
import {
  chunkOfSource,
  listChunkMembers,
  listSessionChunks,
} from '../../../infrastructure/sqlite/chunk-manifest.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import {
  CHUNK_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedHead,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import {
  sealSessionChunk,
  type ChunkNarrativeDeps,
} from '../../../reflection/application/chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../../../reflection/application/installed-publications.js';
import {
  handleReflection,
  type ReflectionIntakeDeps,
} from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { publishPipelineReadinessPolicy } from '../../../reflection/application/readiness.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { OperationContext, OperationOutcome } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { readSealDemand } from '../seal-census.js';

/**
 * The operator, against real stores and a real coordinator.
 *
 * Everything the operation is supposed to decide is decided from durable state here: what is due,
 * what it may spend, what it has to finish first, and what it may not retry on a timer. The
 * provider is scripted and records the exact string it was handed, so a claim that a run asked no
 * model is a claim about a recorded list rather than about a status word.
 *
 * The census this battery reads is taken live rather than stubbed, and the substrate is paired, so
 * no case rests on an absent record reading as a clean one.
 */

const NOW = new Date('2026-09-09T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities'];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One member per chunk. The allowance is what admits, and it is set so that a whole member and
 * its envelope fit inside it while a second member does not: the seal partitions a tail one
 * member at a time and every member still renders whole, so no case here rests on a partial.
 */
const ONE_MEMBER: SealScales = {
  batch: 2,
  maxSpanMs: DAY_MS,
  renderedInputAllowance: 400,
};

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let logger: Logger;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let resolver: EvidenceResolver;

let prompts: string[] = [];
let failAt: PublicationBoundary | undefined;
/** Sources whose synthesis the scripted provider refuses, by the marker their body carries. */
let refuse = new Set<string>();

function citeEveryHandle(prompt: string): unknown {
  const handles = [...prompt.matchAll(/\[(S\d+)\]/g)].map((match) => match[1] ?? '');
  return {
    sentences: handles.map((handle) => ({
      text: `the substrate recorded what ${handle} carried`,
      source_ids: [handle],
    })),
  };
}

const scripted: Provider = {
  embed: () => Promise.reject(new Error('no embedding in this battery')),
  generate: (request: StructuredRequest) => {
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    prompts.push(user);
    for (const marker of refuse) {
      if (user.includes(marker)) {
        return Promise.reject(new Error(`scripted refusal for ${marker}`));
      }
    }
    return Promise.resolve(citeEveryHandle(user));
  },
};

/** Long enough that one member fills the small allowance on its own. */
function body(marker: string): string {
  return `${marker}: ${'the sync keyed on id_slug rather than on npi. '.repeat(6)}`;
}

async function accept(session: string, marker: string, now = NOW): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [body(marker)] },
    { identity: session, now },
  );
  // The incoming-statement census a publication requires before it may rest on "nothing corrects
  // this", established here the way the cohort seal establishes it at scale. Without it the
  // revision holds rather than publishing, which is the C2 evidence contract rather than a
  // scheduling question.
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, result.episode_id, durableRoleScope(role, 'in'), now);
  }
  // The acceptance clock is the substrate's own, deliberately: a caller cannot date its own
  // arrival. Every case here ages against the fixture's fixed clock, so the arrival is moved onto
  // it — a statement about when this source ARRIVED, which stays separable from what it says
  // happened.
  store.db
    .prepare('UPDATE source_records SET created_at = ? WHERE source_id = ?')
    .run(now.toISOString(), result.episode_id);
  return result.episode_id;
}

function context(now = NOW, config: Config = DEFAULTS): OperationContext {
  const demand = readSealDemand(store.db, {
    now,
    batch: ONE_MEMBER.batch,
    maxSpanMs: ONE_MEMBER.maxSpanMs,
    maxMembers: 24,
  });
  return {
    driver: substrate.harness.driver,
    db: store.db,
    config,
    logger,
    provider: scripted,
    narratives: { resolver, publications: coordinator },
    health: healthFixture({ narrativeSeal: demand }),
    now,
    signal: new AbortController().signal,
  };
}

async function runSeal(now = NOW, scales: SealScales = ONE_MEMBER): Promise<OperationOutcome> {
  return narrativeSealOperation(scales).run(context(now));
}

/** The same deps the operation composes, for a case that needs a seal outside a run. */
function chunkDeps(): ChunkNarrativeDeps {
  return {
    driver: substrate.harness.driver,
    db: store.db,
    provider: scripted,
    resolver,
    publications: coordinator,
    logger,
  };
}

/**
 * The substrate is shared by the whole file, so a case that counts what one run did first drains
 * what earlier cases left standing. The drain is bounded and it uses the case's own clock, so a
 * chunk another case backed off stays backed off rather than being swept in here.
 */
async function drain(now: Date): Promise<void> {
  for (let run = 0; run < 12; run += 1) {
    const outcome = await runSeal(now);
    if (
      outcome.itemsProcessed === 0 &&
      outcome.detail?.includes('0 membership(s) sealed') === true
    ) {
      return;
    }
  }
  throw new Error('the substrate did not settle inside a bounded drain');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-narrative-seal-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: ({ boundary }) => {
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
    driver: substrate.harness.driver,
    db: store.db,
    sessions: new SessionManager(substrate.harness.driver, {
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
  resolver = new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    publications: coordinator,
  });
}, 300_000);

beforeEach(() => {
  prompts = [];
  failAt = undefined;
  refuse = new Set<string>();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A tail inside every trigger is not work. The claim is the empty prompt list: the run reached no
 * provider at all, rather than reaching one and being told there was nothing to say.
 */
it('leaves a tail that has reached no trigger alone, and asks no model', async () => {
  await accept('session-quiet', 'quiet');
  const outcome = await runSeal();

  expect(outcome.status).toBe('noop');
  expect(outcome.itemsProcessed).toBe(0);
  expect(prompts).toEqual([]);
  expect(listSessionChunks(store.db, 'session-quiet')).toEqual([]);
});

/**
 * The span trigger, end to end. One run seals what durable state said was due and publishes it,
 * and both halves are reported in the units they were done in.
 */
it('seals an overdue tail and publishes the chunk it sealed', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  const source = await accept('session-span', 'span');
  prompts = [];

  const outcome = await runSeal(later);
  expect(outcome.status).toBe('applied');
  expect(outcome.itemsProcessed).toBe(1);
  expect(outcome.itemsAffected).toBe(1);
  expect(outcome.detail).toContain('1 membership(s) sealed over 1 source(s)');

  const chunkId = chunkOfSource(store.db, source);
  expect(chunkId).toBeDefined();
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId ?? '')).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(body('span'));
});

/**
 * A run is bounded and the remainder is durable, so a tail wider than one run's allowance is
 * drained across runs. What the case actually asserts is the invariant underneath: every source
 * lands in exactly one chunk, and no source lands twice.
 */
it('drains a tail across runs, landing every source in exactly one chunk', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  const sources = [
    await accept('session-drain', 'one'),
    await accept('session-drain', 'two'),
    await accept('session-drain', 'three'),
  ];

  for (let run = 0; run < 6; run += 1) {
    await runSeal(later);
  }

  const chunks = listSessionChunks(store.db, 'session-drain');
  expect(chunks.length).toBeGreaterThan(1);
  const members = chunks.flatMap((chunk) => [...listChunkMembers(store.db, chunk.chunkId)]);
  expect([...members].sort()).toEqual([...sources].sort());
  expect(new Set(members).size).toBe(members.length);
});

/**
 * A synthesis that keeps failing must not hold the queue. The failed attempt is dated forward on
 * its own revision row, which is durable, and the next run reaches the chunk behind it.
 */
it('backs a failing chunk off on its own row and publishes the one behind it', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  refuse.add('stubborn');
  const stubborn = await accept('session-stubborn', 'stubborn');
  const healthy = await accept('session-healthy', 'healthy');

  const first = await runSeal(later);
  expect(first.itemsProcessed).toBe(2);

  const stubbornChunk = chunkOfSource(store.db, stubborn) ?? '';
  const healthyChunk = chunkOfSource(store.db, healthy) ?? '';
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, healthyChunk)).toBe(1);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, stubbornChunk)).toBeUndefined();

  const attempt = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, stubbornChunk, 1);
  expect(attempt?.attempts).toBe(1);
  expect(attempt?.lastFailureReason).toBe('synthesis_failed');
  expect(attempt?.nextAttemptAt).toBeDefined();
  expect(new Date(attempt?.nextAttemptAt ?? '').getTime()).toBeGreaterThan(later.getTime());

  // The backoff is what the next run reads, so a second run spends nothing on it.
  prompts = [];
  const second = await runSeal(later);
  expect(second.itemsProcessed).toBe(0);
  expect(prompts).toEqual([]);

  // And it is durable: the row a restart would read carries the same attempt and the same date.
  const reopened = new SqliteStore({ filePath: substrate.sqlitePath });
  try {
    const durable = readNarrativeRevision(reopened.db, CHUNK_REVISION_FAMILY, stubbornChunk, 1);
    expect(durable?.attempts).toBe(1);
    expect(durable?.nextAttemptAt).toBe(attempt?.nextAttemptAt);
  } finally {
    reopened.close();
  }
});

/**
 * Zero fresh demand and a publication left prepared. The run is called for on the pending half
 * alone: it finishes what the last one started and starts nothing of its own.
 */
it('finishes an interrupted publication with no fresh work to do', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  const source = await accept('session-interrupted', 'interrupted');

  failAt = 'before_ack';
  await expect(runSeal(later)).rejects.toThrow();
  const chunkId = chunkOfSource(store.db, source) ?? '';
  expect(coordinator.hasPending()).toBe(true);

  // The census says nothing fresh is eligible, and the pending reading says otherwise.
  const demand = readSealDemand(store.db, {
    now: later,
    batch: ONE_MEMBER.batch,
    maxSpanMs: ONE_MEMBER.maxSpanMs,
    maxMembers: 24,
  });
  expect(demand.pendingPublishedRepair).toBe(true);

  prompts = [];
  const outcome = await runSeal(later);
  expect(outcome.detail).toContain('1 pending publication(s) recovered');
  expect(prompts).toEqual([]);
  expect(coordinator.hasPending()).toBe(false);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
});

/**
 * A forced run and a scheduled one race through the same fence. Whatever order they reach it in,
 * the chunk carries one published head over its frozen membership and no second revision stands.
 */
it('races two runs through one fence without publishing a chunk twice', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  const source = await accept('session-race', 'race');

  await Promise.allSettled([runSeal(later), runSeal(later)]);

  const chunkId = chunkOfSource(store.db, source) ?? '';
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
  expect(listChunkMembers(store.db, chunkId)).toEqual([source]);
  expect(coordinator.hasPending()).toBe(false);
});

/**
 * Arrival must not outrank age. A tail this run seals joins the same capture-ordered enumeration
 * as everything else that is due, so a substrate taking sources faster than it publishes them
 * cannot spend every slot on its newest tail while the oldest chunk waits.
 */
it('publishes the older due chunk before the tail it sealed in the same run', async () => {
  const later = new Date(NOW.getTime() + 2 * DAY_MS);
  await drain(later);
  const older = await accept('session-fair-older', 'older');
  const olderSeal = await sealSessionChunk(chunkDeps(), 'session-fair-older', {
    now: later,
    sessionClosing: true,
    policy: { ...ONE_MEMBER, maxMembers: 24 },
  });
  if (olderSeal.status !== 'sealed') {
    throw new Error(`the fixture needs a sealed older chunk, got ${olderSeal.status}`);
  }
  const newer = await accept('session-fair-newer', 'newer');

  const outcome = await runSeal(later, { ...ONE_MEMBER, batch: 1 });

  expect(outcome.itemsProcessed).toBe(1);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, olderSeal.chunkId)).toBe(1);
  // The newer tail is sealed durable work and it waits its turn rather than taking the slot.
  const newerChunk = chunkOfSource(store.db, newer) ?? '';
  expect(newerChunk).not.toBe('');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, newerChunk)).toBeUndefined();
  expect(listChunkMembers(store.db, olderSeal.chunkId)).toEqual([older]);

  // And the next run reaches it, so nothing was discharged by being passed over.
  await runSeal(later, { ...ONE_MEMBER, batch: 1 });
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, newerChunk)).toBe(1);
});

/**
 * The other direction of the arrival clock. A conversation about last year arrives now, and the
 * span trigger measures how long the tail has been standing rather than what it says happened —
 * so a backdated source is a fresh tail and waits like any other.
 */
it('leaves a freshly arrived tail alone however far back its subject reaches', async () => {
  await drain(NOW);
  const source = await accept('session-backdated', 'backdated', NOW);
  store.db
    .prepare('UPDATE source_records SET occurred_at = ? WHERE source_id = ?')
    .run(new Date(NOW.getTime() - 400 * DAY_MS).toISOString(), source);
  prompts = [];

  const outcome = await runSeal(NOW);

  expect(chunkOfSource(store.db, source)).toBeUndefined();
  expect(prompts).toEqual([]);
  expect(outcome.detail).toContain('tail(s) inside every trigger');
});

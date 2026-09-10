import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  publishChunkNarrative,
  sealSessionChunk,
  type ChunkNarrativeDeps,
} from './chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { commitSourceState, establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { SUPERSEDES_TYPE } from '../../infrastructure/graph/relationships.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  countEdges,
  countNodesWithId,
  countOpenEdgesInto,
  renameNodeId,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import type { StructuredRequest, Provider } from '../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import {
  listChunkMembers,
  readChunk,
  revisionsDependingOn,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeStatedLinkVersions,
  prepareStatedLinkVersion,
  statedLinkId,
} from '../../infrastructure/sqlite/evidence-links.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedHead,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import { SessionManager } from '../../session/session-manager.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

/**
 * The C2 steady-state lifecycle, end to end against real stores and a real coordinator.
 *
 * The provider is scripted and it records the exact string it was handed, so every claim about
 * what reached the model is asserted on that string rather than on a coverage number. Nothing in
 * this file's import graph constructs a model client: the intake provider rejects both calls, so
 * an accidental generation fails the run instead of passing quietly.
 */

const NOW = new Date('2026-09-09T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities'];

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let chunks: ChunkNarrativeDeps;

/** Every user message the scripted provider was handed, in order. */
let prompts: string[] = [];
/** The chunk the first case sealed, which the second case asks about again. */
let basicChunkId = '';
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

const scripted: Provider = {
  embed: () => Promise.reject(new Error('no embedding in this battery')),
  generate: (request: StructuredRequest) => {
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    prompts.push(user);
    return Promise.resolve(citeEveryHandle(user));
  },
};

/** Long enough that the sentence budget can carry one sentence per member. */
function body(marker: string): string {
  return `${marker}: ${'the sync keyed on id_slug rather than on npi. '.repeat(9)}`;
}

async function accept(session: string, marker: string): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [body(marker)] },
    { identity: session, now: NOW },
  );
  return result.episode_id;
}

function sessionNodeOf(sourceId: string): string {
  const record = readSourceRecord(store.db, sourceId);
  if (record === undefined) {
    throw new Error(`${sourceId} has no source record`);
  }
  return record.sessionId;
}

/** A statement made about a source, recorded and counted the way an acceptance records one. */
function stateCorrection(fromSource: string, toSource: string, operationId: string): void {
  prepareStatedLinkVersion(store.db, {
    linkId: statedLinkId('corrects', 'source', fromSource, toSource),
    kind: 'corrects',
    qualifier: 'source',
    fromId: fromSource,
    toId: toSource,
    operationId,
    operationKey: `${operationId}:corrects`,
    recordedValues: {},
    temporalProof: {},
    observedAt: NOW,
    referenceSourceId: fromSource,
    referenceVersion: 1,
  });
  acknowledgeStatedLinkVersions(store.db, operationId, NOW.toISOString(), NOW.toISOString());
  // Counting the scope again is what moves its published token, which is how a revision that
  // rested on "nothing corrects this" finds out that something now does.
  establishStatementCensus(toSource);
}

/** The incoming-statement census for a source, which is what the cohort seal establishes at scale. */
function establishStatementCensus(sourceId: string): void {
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, sourceId, durableRoleScope(role, 'in'), NOW);
  }
}

function forget(sourceId: string, operationId: string): void {
  commitSourceState(store.db, { sourceId, stateKind: 'forgotten', operationId, at: NOW });
}

function unforget(sourceId: string, operationId: string): void {
  commitSourceState(store.db, { sourceId, stateKind: 'unforgotten', operationId, at: NOW });
}

async function sealAndPublish(session: string): Promise<string> {
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
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    boundary: async ({ boundary }) => {
      expect(store.db.inTransaction).toBe(false);
      if (boundary === 'prepared' && hideAtPrepared !== undefined) {
        const target = hideAtPrepared;
        hideAtPrepared = undefined;
        await renameNodeId(substrate.harness.driver, target, `${target}-hidden`);
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
  chunks = {
    driver: substrate.harness.driver,
    db: store.db,
    provider: scripted,
    resolver: new EvidenceResolver({
      driver: substrate.harness.driver,
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
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('seals a session tail at its close and publishes one revision over exactly its members', async () => {
  const first = await accept('session-basic', 'alpha');
  const second = await accept('session-basic', 'beta');
  const chunkId = await sealAndPublish('session-basic');
  basicChunkId = chunkId;
  expect(listChunkMembers(store.db, chunkId)).toEqual([first, second]);

  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(report.revisionNo).toBe(1);
  expect(report.gaps).toBe(0);

  // The submitted input carried both members' raw text, which is the claim a coverage number
  // cannot make on its own.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(body('alpha'));
  expect(prompts[0]).toContain(body('beta'));

  const properties = await nodeProperties(substrate.harness.driver, report.nodeId);
  expect(properties[NARRATIVE_PROPERTIES.family]).toBe('chunk');
  expect(properties[NARRATIVE_PROPERTIES.chunkId]).toBe(chunkId);
  expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
  expect(await countEdges(substrate.harness.driver, SUMMARIZED_BY_TYPE, first, report.nodeId)).toBe(
    1,
  );
  expect(
    await countEdges(
      substrate.harness.driver,
      DERIVES_FROM_TYPE,
      report.nodeId,
      sessionNodeOf(first),
    ),
  ).toBe(1);

  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
  expect(readChunk(store.db, chunkId)?.state).toBe('published');
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(head?.coverageGapsJson).toBe('[]');
  expect(
    readCitationsFrom(store.db, report.nodeId)
      .map((row) => row.targetId)
      .sort(),
  ).toEqual([first, second].sort());
  expect(revisionsDependingOn(store.db, first).length).toBeGreaterThan(0);
});

it('leaves a head whose dependency versions still read the same, and asks no model', async () => {
  const report = await publishChunkNarrative(chunks, basicChunkId, { now: NOW });
  expect(report.status).toBe('skipped');
  expect(prompts).toEqual([]);
});

it('omits a forgotten member with its gap while its neighbours are submitted whole', async () => {
  const first = await accept('session-forget', 'gamma');
  const forgotten = await accept('session-forget', 'delta');
  const third = await accept('session-forget', 'epsilon');
  const chunkId = await sealAndPublish('session-forget');
  const initial = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(initial.status).toBe('published');
  const firstNode = initial.status === 'published' ? initial.nodeId : '';

  forget(forgotten, 'forget-delta');
  prompts = [];
  const replacement = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(replacement.status).toBe('published');
  if (replacement.status !== 'published') {
    return;
  }
  expect(replacement.revisionNo).toBe(2);
  // The N1 collision, closed: a rewrite over the same membership is a new revision with an id of
  // its own rather than a second write onto the node it replaces.
  expect(replacement.nodeId).not.toBe(firstNode);

  // The forgotten member's content reached no model input, and the healthy neighbours' did.
  expect(prompts[0]).not.toContain(body('delta'));
  expect(prompts[0]).toContain(body('gamma'));
  expect(prompts[0]).toContain(body('epsilon'));

  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(JSON.parse(head?.coverageGapsJson ?? '[]')).toEqual([
    { reason: 'suppressed_member', sourceId: forgotten },
  ]);
  // Membership is frozen: the omitted member is still a member of this chunk.
  expect(listChunkMembers(store.db, chunkId)).toEqual([first, forgotten, third]);
  // The head it replaced stopped summarizing the session, and the new one does.
  expect(await countOpenEdgesInto(substrate.harness.driver, SUMMARIZED_BY_TYPE, firstNode)).toBe(0);
  // Residency decides the edges, and suppression is not eviction: the omitted member is still
  // resident, so its structural edge is written exactly as the manifest records its membership.
  expect(
    await countOpenEdgesInto(substrate.harness.driver, SUMMARIZED_BY_TYPE, replacement.nodeId),
  ).toBe(3);
});

it('publishes nothing for a chunk whose every member is forgotten', async () => {
  const only = await accept('session-all-forgotten', 'zeta');
  const chunkId = await sealAndPublish('session-all-forgotten');
  forget(only, 'forget-zeta');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('blocked');
  if (report.status === 'blocked') {
    expect(report.reason).toBe('no_admissible_input');
  }
  expect(prompts).toEqual([]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const revision = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, 1);
  expect(revision?.blockedReason).toBe('no_admissible_input');
});

it('blocks the whole revision when the correction it must reground on is suppressed', async () => {
  const member = await accept('session-correction', 'eta');
  const corrector = await accept('session-corrector', 'theta');
  establishStatementCensus(member);
  const chunkId = await sealAndPublish('session-correction');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');

  stateCorrection(corrector, member, 'correction-1');
  forget(corrector, 'forget-theta');
  prompts = [];
  const blocked = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(blocked.status).toBe('blocked');
  if (blocked.status === 'blocked') {
    expect(blocked.reason).toBe('required_transition_evidence_suppressed');
  }
  // No model was asked, and the head that stands is the one written before the correction.
  expect(prompts).toEqual([]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);

  // Restored, the same correction is submitted beside the frozen membership.
  unforget(corrector, 'unforget-theta');
  const regrounded = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(regrounded.status).toBe('published');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(body('theta'));
  expect(prompts[0]).toContain(body('eta'));
});

it('seals an oversized member alone and publishes the ranges it actually submitted', async () => {
  const only = await accept('session-oversized', 'iota');
  const policy = { ...CHUNK_BOUNDARY_POLICY, renderedInputAllowance: 200 };
  const sealed = await sealSessionChunk(chunks, 'session-oversized', {
    now: NOW,
    sessionClosing: true,
    policy,
  });
  expect(sealed.status).toBe('sealed');
  if (sealed.status !== 'sealed') {
    return;
  }
  expect(sealed.members).toEqual([only]);

  const report = await publishChunkNarrative(chunks, sealed.chunkId, { now: NOW, policy });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(report.gaps).toBe(1);
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, sealed.chunkId);
  const gaps = JSON.parse(head?.coverageGapsJson ?? '[]') as {
    reason: string;
    sourceId: string;
    submitted: { address: string; start: number; end: number }[];
  }[];
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.reason).toBe('oversized_member');
  expect(gaps[0]?.sourceId).toBe(only);
  expect(gaps[0]?.submitted.length).toBeGreaterThan(0);

  const submitted = gaps[0]?.submitted.reduce((sum, range) => sum + (range.end - range.start), 0);
  expect(submitted).toBeLessThan(body('iota').length);
  const properties = await nodeProperties(substrate.harness.driver, report.nodeId);
  expect(properties[NARRATIVE_PROPERTIES.coverage]).toBeLessThan(1);
  // The gapped revision never claims the whole member: only the submitted prefix reached it.
  expect(prompts[0]).not.toContain(body('iota'));
});

it('defers a publication whose head moved under it, and publishes nothing', async () => {
  const only = await accept('session-race', 'kappa');
  const chunkId = await sealAndPublish('session-race');
  const first = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(first.status).toBe('published');

  // A second attempt carrying the head the first one saw. The guard reads the ACTUAL head, so
  // an output prepared against a superseded one is refused rather than becoming the head.
  const allocation = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  const outcome = await coordinator.publish({
    kind: 'narrative_publish',
    operationId: `stale-head:${chunkId}`,
    payload: {
      chunkId,
      sessionId: sessionNodeOf(only),
      revisionNo: allocation.revisionNo,
      nodeId: allocation.nodeId,
      summary: 'a stale answer',
      narrative: 'a stale answer',
      citations: [{ targetId: only, targetKind: 'source' }],
      sentenceCount: 1,
      coverage: 1,
      occurredAt: NOW.toISOString(),
      members: [{ sourceId: only, residency: 'resident', projectionGeneration: 0 }],
      coverageGaps: [],
      dependencies: [],
      coverageEpoch: readCurrentCoverageContract(store.db)?.epoch ?? '',
      expectedHead: null,
    },
  });
  expect(outcome.status).toBe('deferred');
  if (outcome.status !== 'acknowledged') {
    expect(outcome.reason).toBe('published_head_moved');
  }
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
  expect(await countNodesWithId(substrate.harness.driver, 'Narrative', allocation.nodeId)).toBe(0);
});

it('finishes a publication interrupted between the graph write and the manifest, exactly once', async () => {
  const only = await accept('session-crash', 'lambda');
  const chunkId = await sealAndPublish('session-crash');
  failAt = 'before_ack';
  await expect(publishChunkNarrative(chunks, chunkId, { now: NOW })).rejects.toThrow();

  // The node and the receipt are committed; the manifest has not caught up yet.
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);

  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(head).toBeDefined();
  // Exactly once: a second recovery adds no citation and moves no head.
  const citations = readCitationsFrom(store.db, head?.nodeId ?? '');
  expect(await coordinator.recover()).toBeUndefined();
  expect(readCitationsFrom(store.db, head?.nodeId ?? '')).toEqual(citations);
  expect(citations.map((row) => row.targetId)).toEqual([only]);
});

it('gives an evicted member no edge and keeps its membership and citations', async () => {
  const resident = await accept('session-evicted', 'mu');
  const evicted = await accept('session-evicted', 'nu');
  transitionSourceResidency(store.db, {
    sourceId: evicted,
    state: 'evicted',
    operationId: 'evict-nu',
    transitionedAt: NOW,
  });
  const chunkId = await sealAndPublish('session-evicted');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(listChunkMembers(store.db, chunkId)).toEqual([resident, evicted]);
  expect(
    await countEdges(substrate.harness.driver, SUMMARIZED_BY_TYPE, resident, report.nodeId),
  ).toBe(1);
  expect(
    await countEdges(substrate.harness.driver, SUMMARIZED_BY_TYPE, evicted, report.nodeId),
  ).toBe(0);
  // The evidence is unchanged by eviction, so the evicted member is still submitted and cited.
  expect(prompts[0]).toContain(body('nu'));
  expect(
    readCitationsFrom(store.db, report.nodeId)
      .map((row) => row.targetId)
      .sort(),
  ).toEqual([resident, evicted].sort());
});

it('defers rather than skipping a member the records call resident with no projection', async () => {
  await accept('session-missing', 'xi');
  const vanished = await accept('session-missing', 'omicron');
  const chunkId = await sealAndPublish('session-missing');
  await renameNodeId(substrate.harness.driver, vanished, `${vanished}-hidden`);

  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('deferred');
  if (report.status === 'deferred') {
    expect(report.reason).toBe('member_projection_missing');
  }
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  // The guard was released rather than held: nothing is pending and other writers can publish.
  expect(coordinator.hasPending()).toBe(false);

  // Restored, the same chunk publishes, and its edge names the projection that came back.
  await renameNodeId(substrate.harness.driver, `${vanished}-hidden`, vanished);
  const republished = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(republished.status).toBe('published');
  if (republished.status === 'published') {
    expect(
      await countEdges(substrate.harness.driver, SUMMARIZED_BY_TYPE, vanished, republished.nodeId),
    ).toBe(1);
  }
});

it('refuses the whole write when a projection goes between the check and the edge', async () => {
  const present = await accept('session-vanish', 'rho');
  const vanishing = await accept('session-vanish', 'sigma');
  const chunkId = await sealAndPublish('session-vanish');
  // Deleted after the check passed and before the graph transaction runs, which is the window
  // the signed text calls an inconsistency rather than a member to skip.
  hideAtPrepared = vanishing;
  await expect(publishChunkNarrative(chunks, chunkId, { now: NOW })).rejects.toThrow();
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const attempted = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, 1);
  expect(attempted?.state).not.toBe('published');
  expect(
    await countNodesWithId(substrate.harness.driver, 'Narrative', attempted?.nodeId ?? ''),
  ).toBe(0);
  expect(await countNodesWithId(substrate.harness.driver, 'Episode', present)).toBe(1);

  // The pending attempt is finished by recovery once the projection is back, not by skipping it.
  await renameNodeId(substrate.harness.driver, `${vanishing}-hidden`, vanishing);
  expect((await coordinator.recover())?.status).toBe('acknowledged');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
});

it('seals and publishes while the members still owe every downstream stage', async () => {
  const only = await accept('session-stalled', 'pi');
  const owed = (): number =>
    (
      store.db
        .prepare(
          `SELECT count(*) AS n FROM source_work
           WHERE source_id = ? AND state IN ('pending','retryable','transferred')`,
        )
        .get(only) as { n: number }
    ).n;
  const before = owed();
  expect(before).toBeGreaterThan(0);

  const chunkId = await sealAndPublish('session-stalled');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  // Nothing completed while this ran: enrichment readiness is a different question from whether
  // the session may be written down, and the publication never consulted it.
  expect(owed()).toBe(before);
});

it('serves two chunks of one session at once, and supersedes neither across them', async () => {
  const early = await accept('session-two-chunks', 'tau');
  const first = await sealAndPublish('session-two-chunks');
  const firstPublished = await publishChunkNarrative(chunks, first, { now: NOW });
  expect(firstPublished.status).toBe('published');

  const later = await accept('session-two-chunks', 'upsilon');
  const second = await sealAndPublish('session-two-chunks');
  expect(second).not.toBe(first);
  expect(listChunkMembers(store.db, second)).toEqual([later]);
  const secondPublished = await publishChunkNarrative(chunks, second, { now: NOW });
  expect(secondPublished.status).toBe('published');
  if (firstPublished.status !== 'published' || secondPublished.status !== 'published') {
    return;
  }

  // Both heads stand. The whole-session path closes every open narrative of a session on each
  // write, which across a chunked session would retire the chunk before this one every time.
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, first)).toBe(1);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, second)).toBe(1);
  expect(
    await countOpenEdgesInto(substrate.harness.driver, SUMMARIZED_BY_TYPE, firstPublished.nodeId),
  ).toBe(1);
  expect(
    await countEdges(substrate.harness.driver, SUMMARIZED_BY_TYPE, early, firstPublished.nodeId),
  ).toBe(1);
  // No supersession between two chunks of one session, in either direction.
  expect(
    await countEdges(
      substrate.harness.driver,
      SUPERSEDES_TYPE,
      secondPublished.nodeId,
      firstPublished.nodeId,
    ),
  ).toBe(0);
  expect(
    await countEdges(
      substrate.harness.driver,
      SUPERSEDES_TYPE,
      firstPublished.nodeId,
      secondPublished.nodeId,
    ),
  ).toBe(0);
});

/**
 * The distinct rule the seal-time eligibility fix must not weaken. A member whose evidence was
 * proved when its membership froze, and became unreadable afterwards, keeps its membership: that
 * chunk stays sealed and refuses to publish, and the chunk beside it publishes normally.
 */
it('blocks only its own chunk when a frozen member stops being readable', async () => {
  await accept('session-blocked-neighbour', 'phi');
  const healthyChunk = await sealAndPublish('session-blocked-neighbour');
  const broken = await accept('session-blocked-neighbour', 'chi');
  const brokenChunk = await sealAndPublish('session-blocked-neighbour');
  expect(brokenChunk).not.toBe(healthyChunk);

  // Reversible: the recorded digest stops matching the archive the member is verified against.
  const digest = store.db
    .prepare('SELECT verified_content_digest AS d FROM source_records WHERE source_id = ?')
    .get(broken) as { d: string };
  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run('digest-that-no-archive-row-hashes-to', broken);

  const blocked = await publishChunkNarrative(chunks, brokenChunk, { now: NOW });
  expect(blocked.status).toBe('blocked');
  if (blocked.status === 'blocked') {
    expect(blocked.reason).toBe('member_evidence_missing');
  }
  expect(listChunkMembers(store.db, brokenChunk)).toEqual([broken]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, brokenChunk)).toBeUndefined();

  // Its neighbour is untouched: it publishes on its own evidence.
  const neighbour = await publishChunkNarrative(chunks, healthyChunk, { now: NOW });
  expect(neighbour.status).toBe('published');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, healthyChunk)).toBe(1);

  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run(digest.d, broken);
});

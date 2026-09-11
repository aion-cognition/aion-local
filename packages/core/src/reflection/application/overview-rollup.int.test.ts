import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { publishChunkNarrative, sealSessionChunk } from './chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { rollUpOverviews, type OverviewRollupOptions } from './overview-rollup.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { ROLLUP_WINDOW_PROPERTY } from '../../infrastructure/graph/narrative-rollup-queries.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import {
  countEdges,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { chunkOfSource } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readAttemptPolicy } from '../../infrastructure/sqlite/narrative-allocations.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The calendar overview family, end to end against real stores and a real coordinator.
 *
 * What every case here turns on is that the window's MEMBERSHIP is the manifest's and the write is
 * the coordinator's. The provider is scripted and records the exact string it was handed, so a
 * claim that a refusal asked no model is a claim about a recorded list.
 *
 * The clocks are explicit throughout. World time decides which window a chunk belongs to, and this
 * fixture sets it on the source records rather than inheriting whatever the acceptance stamped, so
 * a midnight-crossing chunk and a late arrival are constructed rather than hoped for.
 */

const NOW = new Date('2026-04-06T00:00:00.000Z');
const EMBED_DIMENSION = 3;

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let logger: Logger;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let resolver: EvidenceResolver;
let prompts: string[] = [];
let failAt: PublicationBoundary | undefined;

/** The grounding review's own prompt, which the synthesis pass runs after the draft. */
const REVIEW_MARKER = 'You review a draft memory';

const scripted: Provider = {
  embed: () => Promise.reject(new Error('no embedding in this battery')),
  generate: (request: StructuredRequest) => {
    const whole = request.messages.map((message) => message.content).join('\n');
    if (whole.includes(REVIEW_MARKER)) {
      return Promise.resolve({
        unsupported: false,
        reason: 'every sentence stays inside its citations',
      });
    }
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    prompts.push(user);
    const handles = [...new Set(user.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
    return Promise.resolve({
      sentences: handles.map((handle) => ({
        text: `the window carried what ${handle} recorded`,
        source_ids: [handle],
      })),
    });
  },
};

function body(marker: string): string {
  return `${marker}: ${'the window recorded what its members said. '.repeat(4)}`;
}

/** One accepted source, with its world time set explicitly and its censuses established. */
async function accept(session: string, marker: string, occurredAt: Date): Promise<string> {
  const result = await handleReflection(
    intake,
    { observations: [body(marker)] },
    { identity: session, now: NOW },
  );
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, result.episode_id, durableRoleScope(role, 'in'), NOW);
  }
  store.db
    .prepare('UPDATE source_records SET occurred_at = ?, created_at = ? WHERE source_id = ?')
    .run(occurredAt.toISOString(), NOW.toISOString(), result.episode_id);
  return result.episode_id;
}

function chunkDeps() {
  return {
    driver: substrate.harness.driver,
    db: store.db,
    provider: scripted,
    resolver,
    publications: coordinator,
    logger,
  };
}

/** A correction whose provenance supersedes a member's source, which invalidates its head. */
async function correct(session: string, target: string): Promise<string> {
  const result = await handleReflection(
    intake,
    {
      observations: [body(`correction-of-${target.slice(0, 6)}`)],
      provenance: { supersedes: [target] },
    },
    { identity: session, now: NOW },
  );
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(store.db, result.episode_id, durableRoleScope(role, 'in'), NOW);
    establishScope(store.db, target, durableRoleScope(role, 'in'), NOW);
  }
  return result.episode_id;
}

/** A published chunk over one source at a stated world time. */
async function publishChunk(session: string, marker: string, occurredAt: Date): Promise<string> {
  await accept(session, marker, occurredAt);
  const sealed = await sealSessionChunk(chunkDeps(), session, {
    now: NOW,
    sessionClosing: true,
  });
  if (sealed.status !== 'sealed') {
    throw new Error(`the fixture needs a sealed chunk, got ${sealed.status}`);
  }
  const report = await publishChunkNarrative(chunkDeps(), sealed.chunkId, { now: NOW });
  if (report.status !== 'published') {
    throw new Error(`the fixture needs a published chunk, got ${report.status}`);
  }
  return sealed.chunkId;
}

function options(overrides: Partial<OverviewRollupOptions> = {}): OverviewRollupOptions {
  return {
    scope: 'day',
    now: NOW,
    windowLimit: 4,
    renderedInputAllowance: 16_384,
    model: DEFAULTS.models.reflect,
    timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
    ...overrides,
  };
}

async function roll(overrides: Partial<OverviewRollupOptions> = {}) {
  return rollUpOverviews(
    {
      driver: substrate.harness.driver,
      db: store.db,
      provider: scripted,
      publications: coordinator,
      logger,
    },
    options(overrides),
  );
}

function headOf(familyKey: string) {
  return readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, familyKey);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-overview-rollup-'));
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
    [{ name: 'entities', run: () => Promise.resolve({ status: 'ok', summary: '' }) }],
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
      generate: () => Promise.reject(new Error('no generation at intake')),
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
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A chunk that crosses midnight belongs to the window its span END falls in, and to one window.
 * The overview cites it and closes nothing: a day does not replace the memories inside it.
 */
it('publishes one window over a midnight-crossing chunk, and supersedes no member', async () => {
  const session = 'overview-midnight';
  const source = await accept(session, 'late-evening', new Date('2026-04-02T23:40:00.000Z'));
  const crossing = await accept(session, 'after-midnight', new Date('2026-04-03T00:20:00.000Z'));
  const sealed = await sealSessionChunk(chunkDeps(), session, { now: NOW, sessionClosing: true });
  if (sealed.status !== 'sealed') {
    throw new Error('the fixture needs a sealed chunk');
  }
  expect(sealed.members).toEqual([source, crossing]);
  const chunk = await publishChunkNarrative(chunkDeps(), sealed.chunkId, { now: NOW });
  if (chunk.status !== 'published') {
    throw new Error('the fixture needs a published chunk');
  }

  const report = await roll();
  expect(report.published).toBe(1);
  const head = headOf('day:2026-04-03');
  expect(head).toBeDefined();
  // The other side of the crossing carries no window of its own.
  expect(headOf('day:2026-04-02')).toBeUndefined();

  const properties = await nodeProperties(substrate.harness.driver, head?.nodeId ?? '');
  expect(properties[ROLLUP_WINDOW_PROPERTY]).toBe('2026-04-03');
  expect(properties[NARRATIVE_PROPERTIES.family]).toBe('overview');
  expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);

  // The member is cited and traversable, and still standing.
  expect(readCitationsFrom(store.db, head?.nodeId ?? '')).toEqual([
    { targetId: chunk.nodeId, targetKind: 'retained_node' },
  ]);
  expect(
    await countEdges(
      substrate.harness.driver,
      SUMMARIZED_BY_TYPE,
      chunk.nodeId,
      head?.nodeId ?? '',
    ),
  ).toBe(1);
  const member = await nodeProperties(substrate.harness.driver, chunk.nodeId);
  expect(member[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
});

/**
 * A window that has not changed is settled: no model call, no second revision. A member that
 * republishes, twice, makes a new overview revision each time — over the SAME member — and the
 * overview closes only its own prior head.
 */
it('re-versions a window over the same member twice and closes only its own head', async () => {
  const memberSource = await accept(
    'overview-double',
    'first-statement',
    new Date('2026-04-01T09:00:00.000Z'),
  );
  const sealed = await sealSessionChunk(chunkDeps(), 'overview-double', {
    now: NOW,
    sessionClosing: true,
  });
  if (sealed.status !== 'sealed') {
    throw new Error('the fixture needs a sealed chunk');
  }
  const { chunkId } = sealed;
  expect((await publishChunkNarrative(chunkDeps(), chunkId, { now: NOW })).status).toBe(
    'published',
  );
  const first = await roll();
  expect(first.published).toBe(1);
  const revisionOne = headOf('day:2026-04-01');

  prompts = [];
  const settled = await roll();
  expect(settled.published).toBe(0);
  expect(settled.settled).toBeGreaterThanOrEqual(1);
  expect(prompts).toEqual([]);

  for (const pass of [2, 3]) {
    // A real correction against the member's own source, which is what invalidates the chunk's
    // head. The member then republishes on its own terms and the window names a different node.
    await correct(`overview-double-correction-${String(pass)}`, memberSource);
    const republished = await publishChunkNarrative(chunkDeps(), chunkId, { now: NOW });
    expect(republished.status).toBe('published');
    const next = await roll();
    expect(next.published).toBe(1);
    expect(headOf('day:2026-04-01')?.revisionNo).toBe(pass);
  }

  // Every earlier overview revision is closed; the member never was.
  const closedFirst = await nodeProperties(substrate.harness.driver, revisionOne?.nodeId ?? '');
  expect(closedFirst[BITEMPORAL_PROPERTIES.validUntil]).toBeDefined();
  const current = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  const memberNode = await nodeProperties(substrate.harness.driver, current?.nodeId ?? '');
  expect(memberNode[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
});

/**
 * A window whose required input does not fit is refused whole. The refusal records the bound it
 * ran under on the attempt itself, so a later run can tell a policy that still stands from one
 * that has moved — and an unchanged one asks no model however often it is visited.
 */
it('refuses a window over the allowance, records the bound, and asks no model', async () => {
  await publishChunk('overview-capacity', 'oversized', new Date('2026-04-04T10:00:00.000Z'));
  prompts = [];

  const refused = await roll({ renderedInputAllowance: 40 });

  expect(refused.blocked).toBeGreaterThanOrEqual(1);
  expect(refused.published).toBe(0);
  expect(prompts).toEqual([]);
  expect(headOf('day:2026-04-04')).toBeUndefined();
  const attempt = readNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-04-04', 1);
  expect(attempt?.blockedReason).toBe('blocked_window_capacity');
  expect(readAttemptPolicy(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-04-04', 1)).toEqual({
    renderedInputAllowance: 40,
  });

  // Unchanged, it refuses again on the same measurement and generates nothing.
  const again = await roll({ renderedInputAllowance: 40 });
  expect(again.published).toBe(0);
  expect(prompts).toEqual([]);

  // Moved, the recorded refusal is a statement about a policy nobody runs: it is reconsidered.
  const reconsidered = await roll();
  expect(reconsidered.reconsidered).toBeGreaterThanOrEqual(1);
  expect(reconsidered.published).toBe(1);
  expect(headOf('day:2026-04-04')).toBeDefined();
});

/**
 * The nested level. A week cites its days, a day cites its chunks, and a chunk cites its sources,
 * so the chain a lineage walk crosses reaches the raw capture from the top without any step kind
 * the walk does not already have.
 */
it('publishes a week over its days and leaves a citation chain to the sources', async () => {
  const dayHead = headOf('day:2026-04-01');
  expect(dayHead).toBeDefined();

  const week = await roll({ scope: 'week' });

  expect(week.published).toBeGreaterThanOrEqual(1);
  const weekHead = headOf('week:2026-W14');
  expect(weekHead).toBeDefined();
  const weekCitations = readCitationsFrom(store.db, weekHead?.nodeId ?? '');
  expect(weekCitations.every((citation) => citation.targetKind === 'retained_node')).toBe(true);
  expect(weekCitations.map((citation) => citation.targetId)).toContain(dayHead?.nodeId);

  // Each level's citations name the level below, down to the source the chunk cited.
  const dayCitations = readCitationsFrom(store.db, dayHead?.nodeId ?? '');
  expect(dayCitations).not.toHaveLength(0);
  const chunkCitations = readCitationsFrom(store.db, dayCitations[0]?.targetId ?? '');
  expect(chunkCitations.some((citation) => citation.targetKind === 'source')).toBe(true);

  // The day it compresses is still standing: a week does not replace the days inside it.
  const dayNode = await nodeProperties(substrate.harness.driver, dayHead?.nodeId ?? '');
  expect(dayNode[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
});

/**
 * A publication interrupted between the graph write and its acknowledgment is finished by the
 * coordinator's own recovery, exactly once, and the number it claimed is the one that publishes.
 */
it('finishes an interrupted overview publication exactly once', async () => {
  const chunkId = await publishChunk(
    'overview-interrupted',
    'interrupted-window',
    new Date('2026-04-05T08:00:00.000Z'),
  );
  expect(chunkOfSource(store.db, (await chunkMembersOf(chunkId))[0] ?? '')).toBe(chunkId);

  failAt = 'before_ack';
  await roll();
  expect(coordinator.hasPending()).toBe(true);

  const recovered = await coordinator.recover();
  expect(recovered?.status).toBe('acknowledged');
  expect(coordinator.hasPending()).toBe(false);
  const head = headOf('day:2026-04-05');
  expect(head?.revisionNo).toBe(1);
  expect(await coordinator.recover()).toBeUndefined();

  // A later run finds the window settled rather than writing a second revision over it.
  prompts = [];
  const after = await roll();
  expect(after.published).toBe(0);
  expect(prompts).toEqual([]);
});

it('releases the revision it bound when recovery turns the attempt away', async () => {
  await publishChunk('overview-released', 'released-window', new Date('2026-04-03T08:00:00.000Z'));

  failAt = 'prepared';
  await roll();
  expect(coordinator.hasPending()).toBe(true);
  const bound = store.db
    .prepare(
      `SELECT family_key AS familyKey, revision_no AS revisionNo FROM overview_revisions
       WHERE state = 'prepared'`,
    )
    .all() as { familyKey: string; revisionNo: number }[];
  expect(bound).toHaveLength(1);
  const held = bound[0] ?? { familyKey: '', revisionNo: 0 };

  // An activation lands in the gap, so the recheck defers and the attempt is discarded.
  const epoch = readCurrentCoverageContract(store.db)?.epoch;
  store.db
    .prepare('UPDATE coverage_contract SET epoch = ? WHERE epoch = ?')
    .run('released-window-activation', epoch);
  expect(await coordinator.recover()).toMatchObject({ status: 'deferred' });

  // The number stays spent and the binding goes back, so a later attempt can take the row up.
  // Left prepared, nothing in the family could ever move it again.
  expect(
    readNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, held.familyKey, held.revisionNo),
  ).toMatchObject({ state: 'allocated', operationId: null });
  expect((await roll()).published).toBeGreaterThan(0);
  expect(headOf(held.familyKey)).toBeDefined();
});

/**
 * A claim that was released rather than published leaves its number spent and the family
 * publishable: the next run takes a number and lands the head, and the abandoned one never
 * becomes a second standing revision.
 */
it('publishes after a released claim without leaving two revisions standing', async () => {
  const familyKey = 'day:2026-04-05';
  const head = headOf(familyKey);
  expect(head).toBeDefined();
  const rows: number[] = [];
  for (let revisionNo = 1; ; revisionNo += 1) {
    const row = readNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo);
    if (row === undefined) {
      break;
    }
    rows.push(revisionNo);
    expect(['published', 'closed', 'abandoned', 'allocated']).toContain(row.state);
  }
  expect(rows.length).toBeGreaterThanOrEqual(1);
  // Exactly one revision of the family is the published head.
  const published = rows.filter(
    (revisionNo) =>
      readNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, familyKey, revisionNo)?.state ===
      'published',
  );
  expect(published).toEqual([head?.revisionNo]);
});

async function chunkMembersOf(chunkId: string): Promise<readonly string[]> {
  const rows = store.db
    .prepare('SELECT source_id FROM chunk_members WHERE chunk_id = ? ORDER BY member_ordinal')
    .all(chunkId) as { source_id: string }[];
  return rows.map((row) => row.source_id);
}

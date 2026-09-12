import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { closeSessionNarrative, SessionNarrativeStage, type NarrativeDeps } from './narratives.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { activatedCoordinator } from './test-support/publication-substrate.fixture.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { NARRATIVE_PROPERTIES } from '../../infrastructure/graph/narrative-queries.js';
import {
  narrativeIdsInSession,
  nodeProperties,
  supersedingNodeIds,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { listChunkMembers } from '../../infrastructure/sqlite/chunk-manifest.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../session/session-manager.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';
import type { StageContext } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * When a still-open session gets a narrative, and which boundary decides.
 *
 * **Re-subjected to the chunk family.** What this file was always about is the timing: the
 * narrative a running session gets before anybody closes it, and the rule that decides when.
 * That rule was the legacy mid-session boundary — a silence gap inside a session, measured
 * against the whole session's coverage — and it is not the chunk family's. The chunk family
 * decides on its own tail: `decideChunkSeal` seals when the unsealed members cross a bound they
 * carry themselves, and `max_span` is the one that fires on elapsed time alone
 * (`reflection/domain/chunk-boundary.ts`). So the cases below are the same four questions asked
 * of that bound.
 *
 * The retirements are named rather than quietly dropped, because two of the old assertions have
 * no chunk equivalent by design:
 *
 * - **The old boundary's kill switch.** The silence-gap decision was consulted only on the
 *   legacy branch, and the chunk route never reads its option. The chunk equivalent of "off, a
 *   running session waits for its close" is structural instead of a switch: the stage dispatches
 *   with `sessionClosing: false`, so a tail inside every bound waits whatever anyone configured.
 *   That is the first case here.
 * - **"supersedes the mid-session version into the one the close writes".** The chunk family
 *   does not version over membership growth — a grown session gets ANOTHER chunk, and both heads
 *   stand. The no-supersession-between-chunks claim is covered directly at
 *   `chunk-narrative.int.test.ts` ('two chunks of one session, and no supersession between
 *   them'); the last case here asserts the half this file is responsible for, which is that the
 *   close seals the tail the stage left rather than rewriting what it already sealed.
 */

const EMBED_DIMENSION = 8;

/** Arrival is what `sealAge` measures the span from, so intake's clock is the one that matters. */
const ARRIVED_AT = new Date('2026-04-02T09:00:00.000Z');
/** Inside the span bound below: the tail is young and the session is open. */
const INSIDE_THE_SPAN = new Date('2026-04-02T09:05:00.000Z');
/** Past it, with nothing closed and nothing added. */
const PAST_THE_SPAN = new Date('2026-04-02T09:45:00.000Z');
const SECOND_ARRIVAL = new Date('2026-04-02T09:50:00.000Z');
const CLOSE_AT = new Date('2026-04-02T09:55:00.000Z');

/** Thirty minutes rather than the shipped day, so the bound is reachable inside one fixture. */
const SPAN_POLICY = { ...CHUNK_BOUNDARY_POLICY, maxSpanMs: 30 * 60 * 1000 };

const SESSION_IDENTITY = 'mid-session-boundary';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;
let deps: NarrativeDeps;
let publications: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let sessionId: string;
let firstEpisodeId: string;

/**
 * The coordinator's clock, moved by hand.
 *
 * A chunk's span bound is measured from ARRIVAL, and arrival is `source_records.created_at`,
 * which the intake publication stamps from the coordinator's clock and not from the `now` the
 * caller passed (`intake-publication.ts`, `acceptedAt: context.now`). Left at the wall clock
 * this file would be measuring a fixture interval against a real one.
 */
let coordinatorNow = ARRIVED_AT;

function stubProvider(): Provider {
  return {
    embed: (texts) =>
      Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5))),
    generate: (request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
      return Promise.resolve({
        sentences: [
          { text: 'The session worked through the Ariadne rollout.', source_ids: handles },
        ],
      });
    },
  };
}

/** One episode, accepted the way an episode arrives, with the census a chunk's planner asks for. */
async function accept(marker: string, at: Date): Promise<string> {
  coordinatorNow = at;
  const stored = await handleReflection(
    intake,
    { observations: [`The pair moved the Ariadne rollout along in ${marker}.`] },
    { identity: SESSION_IDENTITY, now: at },
  );
  const sourceId = stored.episode_id;
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(db, sourceId, durableRoleScope(role, 'in'), at);
  }
  establishScope(db, sourceId, durableRoleScope('stated_derivation', 'out'), at);
  return sourceId;
}

function stageContext(episodeId: string, now: Date): StageContext {
  return {
    driver: harness.driver,
    db,
    publications,
    provider: stubProvider(),
    episodeId,
    episode: { id: episodeId, sessionId, text: `body of ${episodeId}`, turns: [] },
    logger,
    now,
    occurredAt: now,
    pipelineVersion: PIPELINE_VERSION,
  };
}

/** The stage as the worker composes it, carrying the span bound this file measures. */
function stage(): SessionNarrativeStage {
  return new SessionNarrativeStage({ chunkPolicy: SPAN_POLICY });
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-mid-session-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Mid Session' });
  publications = await activatedCoordinator(
    { driver: harness.driver, db, logger, now: () => coordinatorNow },
    'mid-session',
  );
  publishPipelineReadinessPolicy(
    db,
    [{ name: 'entities', run: () => Promise.resolve({ status: 'ok', summary: '' }) }],
    ARRIVED_AT,
  );

  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: stubProvider(),
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications,
    acceptHookCapture: true,
  };
  deps = { driver: harness.driver, db, provider: stubProvider(), logger, publications };

  firstEpisodeId = await accept('mid-e1', ARRIVED_AT);
  await accept('mid-e2', ARRIVED_AT);
  sessionId = readSourceRecord(db, firstEpisodeId)?.sessionId ?? '';
  expect(sessionId).not.toBe('');
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the chunk boundary against a live substrate', () => {
  let firstChunkId: string;

  it('leaves a tail inside every bound to wait, while the session is open', async () => {
    const outcome = await stage().run(stageContext(firstEpisodeId, INSIDE_THE_SPAN));

    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('2 members are inside every bound and the session is open');
    // Read across families: the legacy reader selects `scope = 'session'` by predicate and would
    // report nothing here whether or not anything had been written.
    expect(await narrativeIdsInSession(harness.driver, sessionId)).toEqual([]);
  });

  it('seals and narrates a still-open session once its tail crosses the span bound', async () => {
    const outcome = await stage().run(stageContext(firstEpisodeId, PAST_THE_SPAN));

    expect(outcome.status).toBe('ok');
    expect(outcome.counts).toEqual({ narratives: 1 });
    // No close happened and none was needed: elapsed time alone is what sealed this tail, which
    // is the property the legacy mid-session gap carried and the chunk family carries here.
    expect(outcome.summary).toBe('chunk over 2 sources');

    const written = await narrativeIdsInSession(harness.driver, sessionId);
    expect(written).toHaveLength(1);
    const properties = await nodeProperties(harness.driver, written[0]!);
    expect(properties[NARRATIVE_PROPERTIES.family]).toBe('chunk');
    expect(properties[NARRATIVE_PROPERTIES.revisionNo]).toBe(1);
    expect((properties[NARRATIVE_PROPERTIES.citations] as string[]).length).toBeGreaterThan(0);

    firstChunkId = properties[NARRATIVE_PROPERTIES.chunkId] as string;
    expect(listChunkMembers(db, firstChunkId)).toHaveLength(2);
  });

  it('leaves the boundary alone while the session adds nothing', async () => {
    const outcome = await stage().run(stageContext(firstEpisodeId, PAST_THE_SPAN));

    expect(outcome.status).toBe('skipped');
    // Membership is frozen and the tail behind it is empty, so there is no second reading to
    // take. The legacy boundary said the same thing by counting the whole session's coverage.
    expect(outcome.summary).toBe('the session has no unsealed members');
    expect(await narrativeIdsInSession(harness.driver, sessionId)).toHaveLength(1);
  });

  it('closes over the tail the stage left rather than rewriting what it sealed', async () => {
    const late = await accept('mid-e3', SECOND_ARRIVAL);

    const result = await closeSessionNarrative(deps, sessionId, {
      now: CLOSE_AT,
      chunkPolicy: SPAN_POLICY,
    });

    expect(result).toMatchObject({ status: 'created' });
    const written = await narrativeIdsInSession(harness.driver, sessionId);
    expect(written).toHaveLength(2);

    // A second chunk, not a second revision of the first: the close seals what arrived after the
    // seal and leaves the frozen membership where it was.
    const second = written.find((id) => id !== firstChunkId);
    const properties = await nodeProperties(harness.driver, result.narrativeId!);
    const secondChunkId = properties[NARRATIVE_PROPERTIES.chunkId] as string;
    expect(secondChunkId).not.toBe(firstChunkId);
    expect(listChunkMembers(db, secondChunkId)).toEqual([late]);
    expect(listChunkMembers(db, firstChunkId)).toHaveLength(2);
    expect(second).toBeDefined();

    // Both heads stand. Nothing supersedes anything, in either direction.
    for (const id of written) {
      expect(await supersedingNodeIds(harness.driver, id)).toEqual([]);
    }
  });
});

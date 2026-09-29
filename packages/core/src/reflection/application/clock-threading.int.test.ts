import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { closeSessionNarrative, type NarrativeDeps } from './narratives.js';
import { ReflectionOrchestrator } from './orchestrator.js';
import { publishPipelineReadinessPolicy } from './readiness.js';
import { CognitiveExtractionStage } from './stages/cognitive.js';
import { EntityExtractionStage } from './stages/entities.js';
import {
  activatedCoordinator,
  backdateSubstrateBirth,
} from './test-support/publication-substrate.fixture.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { BASE_NODE_LABEL } from '../../infrastructure/graph/labels.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { NARRATIVE_PROPERTIES } from '../../infrastructure/graph/narrative-queries.js';
import {
  narrativeIdsInSession,
  nodeProperties,
  stampsOfLabel,
  type NodeStamps,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The fixture's own clock, well before anything this suite writes, and the wall clock the run
 * happens on. Every assertion below is the gap between the two: world time belongs to the
 * experience, system time belongs to the write.
 *
 * The graph has to be empty for this to prove anything. `closeFragment` coalesces, and
 * `stampNew` writes only on create, so a second pass over a populated graph agrees with the
 * first whatever clock it ran on. The harness leases a wiped database, which is the condition.
 *
 * **Re-subjected to the chunk family.** The clocks are what this file is about and they are
 * family-neutral, but the narration it proved them through was the legacy whole-session writer.
 * It used to reach that writer by hand-seeding Session, Episode and Turn nodes straight through
 * the graph primitives — which is also why it stopped narrating at all: a session with no source
 * records has no sealable member, and the chunk route answers `the session has no unsealed
 * members`. So the experience now arrives the way an experience arrives, through intake, and the
 * world clock rides in on the turns rather than being handed to the writer.
 *
 * That change is what makes the narrative case stronger rather than weaker. `NarrativeOptions`
 * still takes an `occurredAt`, and the chunk route does not read it: a chunk revision's world
 * time is the END OF THE SPAN ITS MEMBERS COVER (`spanOf`, `chunk-narrative.ts`). So the
 * narrative below is dated to the experience only if every member carried the experience clock
 * through intake — the narrative's stamp is now derived from the episode's, not asserted beside
 * it.
 *
 * The substrate is born before the experience. A substrate stood up today refuses a turn from
 * 2024 at the birth fence, so the only substrate that can take this experience late is one that
 * already existed when it happened: its capture reached it long after, which is the gap measured
 * here. Left on the day of the run, the fence drops both turns, and every stamp below falls back
 * to the run's clock.
 */
const BORN_AT = new Date('2024-01-01T00:00:00.000Z');
const OCCURRED_AT = new Date('2024-11-05T09:15:00.000Z');
const TODAY = new Date();

const SESSION_IDENTITY = 'clock-threading-session';

const TURNS = [
  {
    role: 'user',
    text:
      'Priya Raman and I decided to keep Neo4j as the graph store instead of moving to ' +
      'Postgres, because the traversal queries are the whole point of the pipeline.',
  },
  {
    role: 'assistant',
    text:
      'Understood. Priya Raman owns the Neo4j migration, and Aion extracts entities with ' +
      'Ollama running locally so the pipeline stays self-hosted.',
  },
] as const;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let provider: Provider;
let publications: PublicationCoordinator;
let episodeId: string;
let sessionId: string;

type Stamps = NodeStamps;

async function stampsOf(label: string): Promise<Stamps[]> {
  return stampsOfLabel(harness.driver, label);
}

const BACKBONE_LABELS = ['Member', 'Workspace', 'Substrate'];

function isBackbone(row: Stamps): boolean {
  return row.labels.some((label) => BACKBONE_LABELS.includes(label));
}

/**
 * Every node the substrate holds except the backbone, which is derived from nothing and
 * predates the experience. Scanning the base label rather than a list of the types this
 * pipeline happens to write is what makes the catch-all below cover a node type added later.
 */
async function everyNodeButTheBackbone(): Promise<Stamps[]> {
  const rows = await stampsOf(BASE_NODE_LABEL);
  return rows.filter((row) => !isBackbone(row));
}

function expectExperienceClock(rows: readonly Stamps[]): void {
  for (const row of rows) {
    expect({ id: row.id, occurredAt: row.occurredAt }).toEqual({
      id: row.id,
      occurredAt: OCCURRED_AT,
    });
    expect({ id: row.id, validFrom: row.validFrom }).toEqual({
      id: row.id,
      validFrom: OCCURRED_AT,
    });
    // The write happened during this run, which is months after the experience did.
    expect(row.txFrom?.getTime() ?? 0).toBeGreaterThan(OCCURRED_AT.getTime());
    expect(row.txFrom?.getTime() ?? 0).toBeGreaterThanOrEqual(TODAY.getTime());
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-clock-threading-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  provider = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });

  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Clock Threading' });
  publications = await activatedCoordinator(
    { driver: harness.driver, db, logger },
    'clock-threading',
  );
  await backdateSubstrateBirth(harness.driver, db, BORN_AT);

  const stages = [new EntityExtractionStage(), new CognitiveExtractionStage()];
  publishPipelineReadinessPolicy(
    db,
    stages.map((stage) => ({ name: stage.name, run: stage.run.bind(stage) })),
    TODAY,
  );

  // The experience arrives through intake, carrying its own clock on its turns. `now` is this
  // run's, and the two must not meet: `earliestOccurredAt` reads the turn stamps for world
  // time and falls back to `now` only when an episode carries none.
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications,
  };
  const stored = await handleReflection(
    intake,
    {
      summary: 'deciding to keep Neo4j over Postgres',
      turns: TURNS.map((turn) => ({
        role: turn.role,
        text: turn.text,
        occurred_at: OCCURRED_AT.toISOString(),
      })),
      observations: ['the traversal queries are what the graph store is for'],
    },
    { identity: SESSION_IDENTITY, now: TODAY },
  );
  episodeId = stored.episode_id;
  // Read back from the record rather than from the identity the caller passed: intake resolves
  // an identity to a session node of its own, and the graph is keyed on that id.
  sessionId = readSourceRecord(db, episodeId)?.sessionId ?? '';
  expect(sessionId).not.toBe('');

  // The incoming-statement census a chunk's input planner asks for before it will admit a
  // member. At scale the cohort seal establishes it; here it is one source.
  for (const role of ['stated_correction', 'stated_confirmation'] as const) {
    establishScope(db, episodeId, durableRoleScope(role, 'in'), TODAY);
  }
  establishScope(db, episodeId, durableRoleScope('stated_derivation', 'out'), TODAY);

  const orchestrator = new ReflectionOrchestrator(
    { driver: harness.driver, db, provider, logger, publications },
    stages,
  );
  const run = await orchestrator.run(episodeId, { now: TODAY });
  expect(run.status).toBe('completed');

  const narrativeDeps: NarrativeDeps = {
    driver: harness.driver,
    db,
    provider,
    logger,
    publications,
  };
  // No `occurredAt`: the chunk route does not read one, and passing it would suggest the
  // narrative's world time came from the caller rather than from its members.
  const narrated = await closeSessionNarrative(narrativeDeps, sessionId, { now: TODAY });
  // Asserted as the whole result rather than the status alone: a narrative that refuses says
  // why in its summary, and a bare status turns every refusal into the same opaque failure.
  expect(narrated).toMatchObject({ status: 'created' });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('an experience replayed onto an empty graph long after it happened', () => {
  it('stamps the session with the experience clock and the write with today', async () => {
    const sessions = await stampsOf('Session');
    expect(sessions.map((session) => session.id)).toEqual([sessionId]);
    expectExperienceClock(sessions);
  });

  it('stamps the episode and every turn with the experience clock', async () => {
    const episodes = await stampsOf('Episode');
    const turns = await stampsOf('Turn');
    expect(episodes.map((episode) => episode.id)).toEqual([episodeId]);
    expect(turns).toHaveLength(TURNS.length);
    expectExperienceClock([...episodes, ...turns]);
  });

  it('stamps every entity the pipeline resolved with the experience clock', async () => {
    const entities = (await stampsOf('Entity')).filter((entity) => !isBackbone(entity));
    expect(entities.length).toBeGreaterThan(0);
    expectExperienceClock(entities);
  });

  /**
   * The narrative's world time is derived, not handed over: the chunk revision takes the end of
   * the span its members cover, so this passes only because the episode carried the experience
   * clock through intake and the seal read it back off the member.
   */
  it('dates the chunk narrative to the experience its members cover', async () => {
    const written = await narrativeIdsInSession(harness.driver, sessionId);
    expect(written).toHaveLength(1);

    const properties = await nodeProperties(harness.driver, written[0]!);
    // Family named, so a legacy node passing through this case would fail it rather than read
    // as a chunk revision that happens to share the label.
    expect(properties[NARRATIVE_PROPERTIES.family]).toBe('chunk');
    expect(properties[NARRATIVE_PROPERTIES.scope]).toBe('chunk');

    expectExperienceClock(await stampsOf('Narrative'));
  });

  /**
   * The whole graph at once, so a node type added to the pipeline later is covered without
   * anyone remembering to extend this file: nothing written from the experience may carry
   * the run's clock as its world time.
   */
  it('leaves no node dated to the run rather than to the experience', async () => {
    const written = await everyNodeButTheBackbone();
    expect(written.length).toBeGreaterThan(TURNS.length + 2);
    expectExperienceClock(written);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { closeSessionNarrative, type NarrativeDeps } from './narratives.js';
import { ReflectionOrchestrator } from './orchestrator.js';
import { CognitiveExtractionStage } from './stages/cognitive.js';
import { EntityExtractionStage } from './stages/entities.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { writeStampedDerivedNodeInTransaction } from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { BASE_NODE_LABEL } from '../../infrastructure/graph/labels.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { ensureGraphSession } from '../../infrastructure/graph/sessions.js';
import {
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
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The fixture's own clock, well before anything this suite writes, and the wall clock the run
 * happens on. Every assertion below is the gap between the two: world time belongs to the
 * experience, system time belongs to the write.
 *
 * The graph has to be empty for this to prove anything. `closeFragment` coalesces, and
 * `stampNew` writes only on create, so a second pass over a populated graph agrees with the
 * first whatever clock it ran on. The harness leases a wiped database, which is the condition.
 */
const OCCURRED_AT = new Date('2024-11-05T09:15:00.000Z');
const TODAY = new Date();

const SESSION_ID = 'clock-threading-session';
const EPISODE_ID = 'clock-threading-episode';

const TURNS = [
  {
    id: 'clock-threading-turn-0',
    role: 'user',
    sequence: 0,
    text:
      'Priya Raman and I decided to keep Neo4j as the graph store instead of moving to ' +
      'Postgres, because the traversal queries are the whole point of the pipeline.',
  },
  {
    id: 'clock-threading-turn-1',
    role: 'assistant',
    sequence: 1,
    text:
      'Understood. Priya Raman owns the Neo4j migration, and Aion extracts entities with ' +
      'Ollama running locally so the pipeline stays self-hosted.',
  },
] as const;

const EPISODE_TEXT = [
  'summary: deciding to keep Neo4j over Postgres',
  ...TURNS.map((turn) => `${turn.role}: ${turn.text}`),
  'observation: the traversal queries are what the graph store is for',
].join('\n');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let provider: Provider;

type Stamps = NodeStamps;

/**
 * The episode as it reached the substrate, written at the fixture's clock: the Session, the
 * Episode, its Turns, and the containment edges the pipeline reads them back through.
 */
async function seedExperience(memberId: string, workspaceId: string): Promise<void> {
  await ensureGraphSession(harness.driver, {
    sessionId: SESSION_ID,
    memberId,
    workspaceId,
    now: TODAY,
    occurredAt: OCCURRED_AT,
  });

  await inWriteTransaction(harness.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Episode',
      id: EPISODE_ID,
      now: TODAY,
      occurredAt: OCCURRED_AT,
      properties: {
        [MEMORY_PROPERTIES.text]: EPISODE_TEXT,
        [MEMORY_PROPERTIES.summary]: 'deciding to keep Neo4j over Postgres',
        [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
        [MEMORY_PROPERTIES.extractionMethod]: 'clock_threading_fixture',
        [MEMORY_PROPERTIES.turnCount]: TURNS.length,
      },
    });
    await upsertEdgeInTransaction(tx, {
      type: CONTAINMENT_TYPE,
      sourceId: EPISODE_ID,
      targetId: SESSION_ID,
      strength: 1,
      confidence: 1,
      signals: ['structural'],
      provenance: ['clock_threading_fixture'],
      count: 0,
      now: TODAY,
    });

    for (const turn of TURNS) {
      await writeStampedDerivedNodeInTransaction(tx, {
        label: 'Turn',
        id: turn.id,
        now: TODAY,
        occurredAt: OCCURRED_AT,
        properties: {
          [MEMORY_PROPERTIES.text]: turn.text,
          [MEMORY_PROPERTIES.role]: turn.role,
          [MEMORY_PROPERTIES.sequence]: turn.sequence,
          [MEMORY_PROPERTIES.sessionId]: SESSION_ID,
          [MEMORY_PROPERTIES.sourceEpisodeId]: EPISODE_ID,
          [MEMORY_PROPERTIES.extractionMethod]: 'clock_threading_fixture',
        },
      });
      await upsertEdgeInTransaction(tx, {
        type: CONTAINMENT_TYPE,
        sourceId: turn.id,
        targetId: EPISODE_ID,
        strength: 1,
        confidence: 1,
        signals: ['structural'],
        provenance: ['clock_threading_fixture'],
        count: 0,
        now: TODAY,
      });
    }
  });
}

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
  await seedExperience(backbone.member.id, backbone.workspace.id);

  const orchestrator = new ReflectionOrchestrator(
    { driver: harness.driver, db, provider, logger },
    [new EntityExtractionStage(), new CognitiveExtractionStage()],
  );
  const run = await orchestrator.run(EPISODE_ID, { now: TODAY });
  expect(run.status).toBe('completed');

  // Narration publishes, so the coordinator and its SQLite side are part of the composition.
  // Without them `narrateSession` fails closed before it reads an episode, and the whole file
  // reports a narrative that was never attempted.
  const publications = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await publications.initialize();

  const narrativeDeps: NarrativeDeps = {
    driver: harness.driver,
    db,
    provider,
    logger,
    publications,
  };
  const narrated = await closeSessionNarrative(narrativeDeps, SESSION_ID, {
    now: TODAY,
    occurredAt: OCCURRED_AT,
  });
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
    expect(sessions.map((session) => session.id)).toEqual([SESSION_ID]);
    expectExperienceClock(sessions);
  });

  it('stamps the episode and every turn with the experience clock', async () => {
    const episodes = await stampsOf('Episode');
    const turns = await stampsOf('Turn');
    expect(episodes.map((episode) => episode.id)).toEqual([EPISODE_ID]);
    expect(turns.map((turn) => turn.id)).toEqual(TURNS.map((turn) => turn.id));
    expectExperienceClock([...episodes, ...turns]);
  });

  it('stamps every entity the pipeline resolved with the experience clock', async () => {
    const entities = (await stampsOf('Entity')).filter((entity) => !isBackbone(entity));
    expect(entities.length).toBeGreaterThan(0);
    expectExperienceClock(entities);
  });

  it('stamps the narrative with the experience clock', async () => {
    const narratives = await stampsOf('Narrative');
    expect(narratives).toHaveLength(1);
    expectExperienceClock(narratives);
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

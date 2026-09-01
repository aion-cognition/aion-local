import neo4j, { type Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReflectionOrchestrator } from './orchestrator.js';
import { replayExperiences, type ReplayDeps } from './replay.js';
import { CognitiveExtractionStage } from './stages/cognitive.js';
import { ENTITY_STAGE_NAME, EntityExtractionStage } from './stages/entities.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  countNodes,
  countRelationships,
  episodeIdsInSession,
  mentionCounts,
  nodeProperties,
  participationCount,
  storedEntities,
  turnsOfEpisode,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { fromGraphDateTime } from '../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { SessionManager } from '../../session/session-manager.js';
import type { ReflectionContent } from '../domain/content.js';
import { stageLedgerKey } from '../domain/stage.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * The replay runner against a real Neo4j the harness leases empty, which is the condition the
 * whole exercise depends on: `closeFragment` coalesces and `stampNew` writes only on create, so
 * a replay onto a populated graph agrees with the first pass whatever clock it ran on.
 *
 * Every experience below is dated well in the past and archived today, so a stamp taken from
 * the replay's own moment is visible rather than plausible.
 */

const IDENTITY = 'replay-acceptance-session';
const ARCHIVED_AT = '2026-09-01T12:00:00.000Z';
const BUMPED_VERSION = 'replay-acceptance-v2';

/** The wall clock the replay runs on: months after the newest experience it puts back. */
const REPLAYED_AT = new Date('2026-09-01T13:00:00.000Z');
/** A day later for the second pass, so an unmoved `tx_from` is unmoved and not rewritten. */
const REPLAYED_AGAIN_AT = new Date('2026-09-02T13:00:00.000Z');

const EXPERIENCES = [
  {
    occurredAt: '2025-02-11T09:00:00.000Z',
    summary: 'keeping Neo4j as the graph store',
    turns: [
      'Priya Raman and I decided to keep Neo4j as the graph store instead of moving to ' +
        'Postgres, because the traversal queries are the whole point of the pipeline.',
      'Understood. Priya Raman owns the Neo4j migration from here.',
    ],
  },
  {
    occurredAt: '2025-03-04T14:30:00.000Z',
    summary: 'moving embeddings onto Ollama',
    turns: [
      'We moved the embedding model to Ollama so the pipeline runs self-hosted. Marcus Webb ' +
        'wants the inference bill off the roadmap entirely.',
      'Noted. Marcus Webb signed off on running Ollama locally for embeddings.',
    ],
  },
  {
    occurredAt: '2025-04-19T18:45:00.000Z',
    summary: 'the redaction pass runs before hashing',
    turns: [
      'Redaction has to run before the content hash, otherwise a secret reaches the archive. ' +
        'Dana Okafor caught that in review.',
      'Agreed. Dana Okafor is right that redaction goes first.',
    ],
  },
] as const;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let provider: Provider;
let deps: ReplayDeps;
/** Driver calls that can write, counted since the last reset. */
let writeCalls = 0;

/** Both stages the replay runs, by the name each writes its own ledger key under. */
const STAGE_NAMES = [ENTITY_STAGE_NAME, 'cognitive'] as const;

function contentOf(index: number): ReflectionContent {
  const experience = EXPERIENCES[index];
  if (experience === undefined) {
    throw new Error(`no experience at ${String(index)}`);
  }
  return {
    summary: experience.summary,
    turns: experience.turns.map((text, sequence) => ({
      role: sequence === 0 ? 'user' : 'assistant',
      text,
      occurred_at: experience.occurredAt,
    })),
  };
}

function archive(index: number, schemaVersion = ARCHIVE_SCHEMA_VERSION): boolean {
  const experience = EXPERIENCES[index];
  if (experience === undefined) {
    throw new Error(`no experience at ${String(index)}`);
  }
  return insertExperience(db, {
    schemaVersion,
    pipelineVersion: PIPELINE_VERSION,
    identity: IDENTITY,
    sessionId: IDENTITY,
    episodeId: `archived-episode-${String(index)}`,
    contentHash: `archived-hash-${String(index)}`,
    occurredAt: experience.occurredAt,
    archivedAt: ARCHIVED_AT,
    payload: contentOf(index),
  });
}

/**
 * Every write path goes through one of two driver calls: `inWriteTransaction` opens a session,
 * and the write-routed helpers pass `routing: WRITE` to `executeQuery`. Counting both is how a
 * pass that claims to write nothing is held to it.
 */
function countingDriver(driver: Driver): Driver {
  return new Proxy(driver, {
    get(target, property) {
      if (property === 'session') {
        return (...args: unknown[]) => {
          writeCalls += 1;
          return (target.session as (...rest: unknown[]) => unknown)(...args);
        };
      }
      if (property === 'executeQuery') {
        return (
          cypher: string,
          parameters: Record<string, unknown>,
          config?: Parameters<Driver['executeQuery']>[2],
        ) => {
          if (config?.routing === neo4j.routing.WRITE) {
            writeCalls += 1;
          }
          return target.executeQuery(cypher, parameters, config);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** Every stamp on every node the replay wrote, keyed by id, so a second pass is compared to it. */
async function stampsOf(ids: readonly string[]): Promise<Record<string, unknown>[]> {
  return Promise.all(ids.map((id) => nodeProperties(harness.driver, id)));
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-replay-acceptance-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  provider = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });

  await runGraphMigrations(harness.driver, db, {
    embedDimension: DEFAULTS.models.embedDimension,
  });
  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Replay Acceptance' });

  const driver = countingDriver(harness.driver);
  deps = {
    driver,
    db,
    sessions: new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    logger,
    runner: new ReflectionOrchestrator({ driver, db, provider, logger }, [
      new EntityExtractionStage(),
      new CognitiveExtractionStage(),
    ]),
  };

  for (const index of EXPERIENCES.keys()) {
    expect(archive(index)).toBe(true);
  }
}, 600_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('replaying an archive onto an empty scratch substrate', () => {
  let episodeIds: string[];

  it('derives one episode per archived experience, on the experience clock', async () => {
    const report = await replayExperiences(deps, { batchSize: 2, clock: () => REPLAYED_AT });

    expect({ scanned: report.scanned, replayed: report.replayed, failed: report.failed }).toEqual({
      scanned: EXPERIENCES.length,
      replayed: EXPERIENCES.length,
      failed: 0,
    });

    episodeIds = (await episodeIdsInSession(harness.driver, IDENTITY)).sort();
    expect(episodeIds).toHaveLength(EXPERIENCES.length);

    const stamps = await stampsOf(episodeIds);
    const occurred = stamps
      .map((props) => fromGraphDateTime(props.occurred_at)?.toISOString() ?? 'missing')
      .sort();
    expect(occurred).toEqual([...EXPERIENCES].map((experience) => experience.occurredAt).sort());
    for (const props of stamps) {
      // World time is the experience's, on both axes: none of these is dated to the run.
      expect(fromGraphDateTime(props.valid_from)).toEqual(fromGraphDateTime(props.occurred_at));
      // System time is the run's. The substrate learned this today, whatever year it happened.
      expect(fromGraphDateTime(props.tx_from)).toEqual(REPLAYED_AT);
    }
  }, 600_000);

  it('writes the turns and the derived nodes each episode is the source of', async () => {
    for (const episodeId of episodeIds) {
      const turns = await turnsOfEpisode(harness.driver, episodeId);
      expect(turns).toHaveLength(2);
      // The same split one level down: a turn carries its conversation's date and the
      // replay's write stamp.
      for (const turn of turns) {
        expect(fromGraphDateTime(turn.valid_from)).toEqual(fromGraphDateTime(turn.occurred_at));
        expect(fromGraphDateTime(turn.tx_from)).toEqual(REPLAYED_AT);
      }
      expect(await participationCount(harness.driver, episodeId)).toBeGreaterThan(0);
      expect(await mentionCounts(harness.driver, episodeId)).not.toHaveLength(0);
    }

    const entities = await storedEntities(harness.driver);
    expect(entities.filter((entity) => !entity.structural).length).toBeGreaterThan(0);
  });
});

describe('replaying the same archive a second time', () => {
  let stampsBefore: Record<string, unknown>[];
  let entitiesBefore: unknown;
  let nodesBefore: number;
  let edgesBefore: number;
  let episodeIds: string[];

  it('answers already_applied for every row without touching the graph', async () => {
    episodeIds = (await episodeIdsInSession(harness.driver, IDENTITY)).sort();
    stampsBefore = await stampsOf(episodeIds);
    entitiesBefore = await storedEntities(harness.driver);
    nodesBefore = await countNodes(harness.driver);
    edgesBefore = await countRelationships(harness.driver);
    writeCalls = 0;

    const report = await replayExperiences(deps, { batchSize: 2, clock: () => REPLAYED_AGAIN_AT });

    expect({ scanned: report.scanned, skipped: report.skipped, replayed: report.replayed }).toEqual(
      { scanned: EXPERIENCES.length, skipped: EXPERIENCES.length, replayed: 0 },
    );
    expect(writeCalls).toBe(0);
  }, 600_000);

  it('leaves every stamp and every count exactly where the first pass left them', async () => {
    const stamps = await stampsOf(episodeIds);
    expect(stamps).toEqual(stampsBefore);
    // A day of wall clock passed between the two passes and no `tx_from` moved with it: the
    // second pass read the ledger rather than rewriting what the first one wrote.
    for (const props of stamps) {
      expect(fromGraphDateTime(props.tx_from)).toEqual(REPLAYED_AT);
    }
    expect(await storedEntities(harness.driver)).toEqual(entitiesBefore);
    expect(await countNodes(harness.driver)).toBe(nodesBefore);
    expect(await countRelationships(harness.driver)).toBe(edgesBefore);
  });
});

describe('replaying under a bumped pipeline version', () => {
  it('re-enters every stage rather than reading the ledger the old version wrote', async () => {
    const episodeIds = await episodeIdsInSession(harness.driver, IDENTITY);
    for (const episodeId of episodeIds) {
      for (const stage of STAGE_NAMES) {
        expect(isLedgerApplied(db, stageLedgerKey(PIPELINE_VERSION, stage, episodeId))).toBe(true);
        expect(isLedgerApplied(db, stageLedgerKey(BUMPED_VERSION, stage, episodeId))).toBe(false);
      }
    }

    const report = await replayExperiences(deps, {
      batchSize: 2,
      pipelineVersion: BUMPED_VERSION,
      clock: () => REPLAYED_AGAIN_AT,
    });

    expect({ replayed: report.replayed, skipped: report.skipped }).toEqual({
      replayed: EXPERIENCES.length,
      skipped: 0,
    });
    for (const episodeId of episodeIds) {
      for (const stage of STAGE_NAMES) {
        expect(isLedgerApplied(db, stageLedgerKey(BUMPED_VERSION, stage, episodeId))).toBe(true);
      }
    }
  }, 600_000);
});

describe('an archived row whose identity resolves to a session that already has the episode', () => {
  it('dedupes onto the stored episode by content hash instead of writing a second one', async () => {
    const episodesBefore = await episodeIdsInSession(harness.driver, IDENTITY);
    // A second envelope version of the same experience: one payload, one identity, two rows.
    expect(archive(0, ARCHIVE_SCHEMA_VERSION + 1)).toBe(true);

    const report = await replayExperiences(deps, {
      batchSize: 10,
      selection: { episodeId: 'archived-episode-0' },
      clock: () => REPLAYED_AGAIN_AT,
    });

    expect({ scanned: report.scanned, skipped: report.skipped, replayed: report.replayed }).toEqual(
      { scanned: 2, skipped: 2, replayed: 0 },
    );
    expect((await episodeIdsInSession(harness.driver, IDENTITY)).sort()).toEqual(
      episodesBefore.sort(),
    );
  }, 600_000);
});

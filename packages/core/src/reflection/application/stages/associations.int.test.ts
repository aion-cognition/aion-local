import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AssociationInferenceStage } from './associations.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import {
  linkEntityMentions,
  mergeEntities,
  writeEntityVectors,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  coOccurrencePairs,
  setCoOccursStrength,
  similarPairsAmong,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { cliqueDiscount } from '../../../plasticity/domain/reinforcement.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext, StageOutcome } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const DIMENSION = DEFAULTS.models.embedDimension;

/**
 * This stage never calls a model: it reads entities and content vectors already in the
 * graph. Intake still needs a `Provider` to embed episode/turn text, so it gets a fully
 * synthetic one: deterministic, dependency-free, and irrelevant to what this suite verifies.
 */
function fakeVector(seed: number): Vector {
  return Array.from({ length: DIMENSION }, (_, slot) => Math.sin(seed + slot));
}

function fakeProvider(): Provider {
  let counter = 0;
  return {
    embed: async (texts: readonly string[]): Promise<Vector[]> =>
      texts.map(() => fakeVector(++counter)),
    generate: async (): Promise<unknown> => {
      throw new Error('this suite never extracts entities through the model');
    },
  };
}

/** An exact-basis vector: cosine 1 against itself or an identical copy, 0 against a different basis index. */
function basisVector(index: number): Vector {
  return Array.from({ length: DIMENSION }, (_, slot) => (slot === index ? 1 : 0));
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let intake: ReflectionIntakeDeps;

async function newEpisode(text: string): Promise<string> {
  const result = await handleReflection(
    intake,
    { turns: [{ role: 'user', text }] },
    { identity: `associations-${text}` },
  );
  return result.episode_id;
}

async function seedEntity(input: {
  readonly name: string;
  readonly type: string;
  readonly episodeId: string;
  readonly vector?: Vector;
}): Promise<string> {
  const merge: EntityMergeInput = {
    name: input.name,
    nameNorm: input.name.toLowerCase(),
    type: input.type,
    text: `${input.name} (${input.type})`,
    sourceEpisodeId: input.episodeId,
    extractionMethod: 'test-fixture',
    confidence: 0.8,
  };
  const [merged] = await mergeEntities(harness.driver, [merge], NOW);
  if (merged === undefined) {
    // One input entity always merges to exactly one result; this fixture only ever calls
    // mergeEntities with a single-element array.
    throw new Error('mergeEntities returned no result for a single-entity merge');
  }
  const { id } = merged;
  if (input.vector !== undefined) {
    await writeEntityVectors(harness.driver, [{ id, contentVector: input.vector }]);
  }
  await linkEntityMentions(harness.driver, {
    episodeId: input.episodeId,
    entityIds: [id],
    now: NOW,
    confidence: 0.8,
    provenance: ['test-fixture'],
  });
  return id;
}

async function runStage(episodeId: string): Promise<StageOutcome> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  if (episode === undefined) {
    throw new Error(`no episode ${episodeId}`);
  }
  const context: StageContext = {
    driver: harness.driver,
    db,
    provider: fakeProvider(),
    episodeId,
    episode,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
  return new AssociationInferenceStage().run(context);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-associations-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: fakeProvider(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('co-occurrence', () => {
  it('links every pair in a 3-entity episode with count 1, holds on a same-episode re-run, and bumps on a second episode', async () => {
    const episodeOne = await newEpisode('co-occurrence fixture one');
    await seedEntity({ name: 'Priya', type: 'person', episodeId: episodeOne });
    await seedEntity({ name: 'Aion', type: 'project', episodeId: episodeOne });
    await seedEntity({ name: 'Neo4j', type: 'tool', episodeId: episodeOne });

    const first = await runStage(episodeOne);
    expect(first.status).toBe('ok');
    expect(first.counts?.associations).toBe(3);

    let pairs = await coOccurrencePairs(harness.driver);
    expect(pairs).toHaveLength(3);
    expect(pairs.every((pair) => pair.count === 1)).toBe(true);

    const rerun = await runStage(episodeOne);
    expect(rerun.counts?.associations).toBe(0);
    pairs = await coOccurrencePairs(harness.driver);
    expect(pairs.every((pair) => pair.count === 1)).toBe(true);

    const episodeTwo = await newEpisode('co-occurrence fixture two');
    await seedEntity({ name: 'Priya', type: 'person', episodeId: episodeTwo });
    await seedEntity({ name: 'Aion', type: 'project', episodeId: episodeTwo });

    const second = await runStage(episodeTwo);
    expect(second.counts?.associations).toBe(1);

    pairs = await coOccurrencePairs(harness.driver);
    const priyaAion = pairs.find((pair) => pair.a === 'Aion' && pair.b === 'Priya');
    expect(priyaAion?.count).toBe(2);
  }, 180_000);

  it("writes a wide episode's pairs weaker than a focused episode's, and grows them on repeat", async () => {
    const wide = await newEpisode('a wide episode');
    const wideNames = ['W1', 'W2', 'W3', 'W4', 'W5'];
    for (const name of wideNames) {
      await seedEntity({ name, type: 'concept', episodeId: wide });
    }
    await runStage(wide);

    const focused = await newEpisode('a focused episode');
    for (const name of ['F1', 'F2']) {
      await seedEntity({ name, type: 'concept', episodeId: focused });
    }
    await runStage(focused);

    const pairs = await coOccurrencePairs(harness.driver);
    const widePair = pairs.find((pair) => pair.a === 'W1' && pair.b === 'W2');
    const focusedPair = pairs.find((pair) => pair.a === 'F1' && pair.b === 'F2');

    // One node's worth of evidence split across the four partners a five-entity episode gave
    // each of them, against the whole of it for the only pair a two-entity episode names.
    expect(widePair?.strength).toBeCloseTo(cliqueDiscount(wideNames.length), 10);
    expect(focusedPair?.strength).toBe(1);

    // Saying it again closes part of the remaining gap rather than jumping to the ceiling.
    const wideAgain = await newEpisode('the wide episode said again');
    for (const name of wideNames) {
      await seedEntity({ name, type: 'concept', episodeId: wideAgain });
    }
    await runStage(wideAgain);

    const grown = (await coOccurrencePairs(harness.driver)).find(
      (pair) => pair.a === 'W1' && pair.b === 'W2',
    );
    const eta = cliqueDiscount(wideNames.length);
    expect(grown?.strength).toBeCloseTo(eta + eta * (1 - eta), 10);
    expect(grown?.strength).toBeLessThan(1);
  }, 180_000);

  it('does not restore a decayed pair to full strength on the next co-occurrence', async () => {
    const first = await newEpisode('a pair that will fade');
    for (const name of ['D1', 'D2', 'D3']) {
      await seedEntity({ name, type: 'concept', episodeId: first });
    }
    await runStage(first);

    await setCoOccursStrength(harness.driver, 'D1', 'D2', 0.2);

    const again = await newEpisode('the faded pair said again');
    for (const name of ['D1', 'D2', 'D3']) {
      await seedEntity({ name, type: 'concept', episodeId: again });
    }
    await runStage(again);

    const faded = (await coOccurrencePairs(harness.driver)).find(
      (pair) => pair.a === 'D1' && pair.b === 'D2',
    );
    const eta = cliqueDiscount(3);
    expect(faded?.strength).toBeCloseTo(0.2 + eta * (1 - 0.2), 10);
  }, 180_000);
});

describe('semantic similarity', () => {
  it('links entities at or above the threshold and leaves entities below it unlinked', async () => {
    const episode = await newEpisode('semantic similarity fixture');
    await seedEntity({
      name: 'Postgres',
      type: 'tool',
      episodeId: episode,
      vector: basisVector(0),
    });
    await seedEntity({
      name: 'PostgresAlias',
      type: 'tool',
      episodeId: episode,
      vector: basisVector(0),
    });
    await seedEntity({
      name: 'Unrelated',
      type: 'concept',
      episodeId: episode,
      vector: basisVector(200),
    });

    const outcome = await runStage(episode);

    expect(outcome.status).toBe('ok');
    const similar = await similarPairsAmong(harness.driver, [
      'Postgres',
      'PostgresAlias',
      'Unrelated',
    ]);
    // SIMILAR is undirected; the edge-upsert normalizes endpoints by id, not by name, so
    // either entity can land on either side.
    expect(similar).toHaveLength(1);
    expect(new Set([similar[0]?.a, similar[0]?.b])).toEqual(new Set(['Postgres', 'PostgresAlias']));
    expect(similar[0]?.strength).toBeCloseTo(1, 5);
    expect(similar.some((pair) => pair.a === 'Unrelated' || pair.b === 'Unrelated')).toBe(false);
  }, 180_000);

  it('is idempotent: re-running finds the same candidates and leaves the edge a no-op', async () => {
    const episode = await newEpisode('semantic similarity re-run fixture');
    await seedEntity({
      name: 'Kubernetes',
      type: 'tool',
      episodeId: episode,
      vector: basisVector(50),
    });
    await seedEntity({ name: 'K8s', type: 'tool', episodeId: episode, vector: basisVector(50) });

    const first = await runStage(episode);
    const second = await runStage(episode);

    expect(first.counts?.associations).toBeGreaterThan(0);
    expect(second.counts?.associations).toBe(0);
    const similar = await similarPairsAmong(harness.driver, ['Kubernetes', 'K8s']);
    expect(similar).toHaveLength(1);
  }, 180_000);
});

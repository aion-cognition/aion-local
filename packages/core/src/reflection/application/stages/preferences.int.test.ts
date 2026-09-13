import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PreferenceInferenceStage } from './preferences.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { DERIVES_FROM_TYPE } from '../../../infrastructure/graph/narrative-queries.js';
import {
  findStandingPreferences,
  readPreference,
} from '../../../infrastructure/graph/preference-queries.js';
import {
  countOutgoingEdges,
  nodeLabels,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import type { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { saveLastPack } from '../../../infrastructure/sqlite/last-pack.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { directIntakePublisher } from '../../test-support/direct-intake.fixture.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { activatedCoordinator } from '../test-support/publication-substrate.fixture.js';

/**
 * The preference lifecycle against real stores, with the model's answer injected: a fixture
 * interaction yields a preference with its grounding, serving puts it in the preferences bucket
 * labelled as an inference, and a later contradicting signal revises it.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-09-13T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let publications: PublicationCoordinator;
let intake: ReflectionIntakeDeps;

function vector(seed: number): Vector {
  return Array.from({ length: DIMENSION }, (_, slot) => Math.sin(seed + slot));
}

function provider(generate: () => unknown): Provider {
  let counter = 0;
  return {
    embed: (texts: readonly string[]): Promise<Vector[]> =>
      Promise.resolve(
        texts.map(() => {
          counter += 1;
          return vector(counter);
        }),
      ),
    generate: () => Promise.resolve(generate()),
  };
}

async function newEpisode(
  identity: string,
  turns: readonly { role: string; text: string }[],
): Promise<string> {
  const stored = await handleReflection(intake, { turns: [...turns] }, { identity });
  return stored.episode_id;
}

async function context(episodeId: string, generate: () => unknown): Promise<StageContext> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  expect(episode).toBeDefined();
  return {
    driver: harness.driver,
    db,
    provider: provider(generate),
    episodeId,
    episode: episode!,
    logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
    publications,
  };
}

const CORRECTING_TURNS = [
  { role: 'user', text: 'run the dry run first, I want to see the rows before you touch prod' },
  { role: 'assistant', text: 'ran it, 412 rows would change' },
  { role: 'user', text: 'again: dry run first. never run a destructive command without one' },
  { role: 'assistant', text: 'understood, dry run first from now on' },
];

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-preferences-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
  publications = await activatedCoordinator({ driver: harness.driver, db, logger }, 'preferences');

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  intake = {
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
    publications: directIntakePublisher(harness.driver, db),
  };
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PreferenceInferenceStage over real stores', () => {
  it('reads a preference off a repeated correction and keeps its grounding', async () => {
    const episodeId = await newEpisode('preference-grounding', CORRECTING_TURNS);

    const outcome = await new PreferenceInferenceStage().run(
      await context(episodeId, () => ({
        preferences: [
          {
            text: 'asks for a dry run before any destructive command',
            grounds: ['S1', 'S3'],
            scope: 'standing',
            confidence: 0.8,
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.preferences).toBe(1);

    const held = await findStandingPreferences(harness.driver, 10);
    expect(held).toHaveLength(1);
    const stored = await readPreference(harness.driver, held[0]!.id);
    expect(stored?.inferred).toBe(true);
    expect(stored?.scope).toBe('standing');
    expect(stored?.roles).toEqual(['user']);
    expect(stored?.observations).toBe(2);
    expect(await nodeLabels(harness.driver, held[0]!.id)).toEqual(
      expect.arrayContaining(['Preference', 'Memory', 'AionNode']),
    );
    expect(await countOutgoingEdges(harness.driver, DERIVES_FROM_TYPE, held[0]!.id)).toBe(2);
  }, 300_000);

  it('revises a held preference when a later signal contradicts it', async () => {
    const episodeId = await newEpisode('preference-revision', [
      { role: 'user', text: 'skip the dry run on the staging cleanup, just run it' },
      { role: 'assistant', text: 'running it' },
      { role: 'user', text: 'same on the sandbox reset, no dry run needed there either' },
    ]);

    const held = await findStandingPreferences(harness.driver, 10);
    expect(held).toHaveLength(1);
    const original = held[0]!.id;

    const outcome = await new PreferenceInferenceStage().run(
      await context(episodeId, () => ({
        preferences: [
          {
            text: 'asks for a dry run before a destructive command on production only',
            grounds: ['S1', 'S3'],
            scope: 'standing',
            revises: 'P1',
            confidence: 0.7,
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toContain('revising a held one');

    const replaced = await readPreference(harness.driver, original);
    expect(replaced?.closedAt).toBeDefined();

    const successors = await supersedingNodeIds(harness.driver, original);
    expect(successors).toHaveLength(1);
    const successor = await readPreference(harness.driver, successors[0]!);
    expect(successor?.text).toBe(
      'asks for a dry run before a destructive command on production only',
    );
    expect(successor?.closedAt).toBeUndefined();
  }, 300_000);

  it('does not re-read a preference this session was already served', async () => {
    const episodeId = await newEpisode('preference-echo', [
      { role: 'user', text: 'right, and keep doing the dry run on prod' },
      { role: 'assistant', text: 'dry run on prod, noted' },
    ]);
    const episode = await loadEpisodeContext(harness.driver, episodeId);
    const held = await findStandingPreferences(harness.driver, 10);
    const served = held.find((row) => row.text.includes('production only'));
    expect(served).toBeDefined();

    saveLastPack(db, episode!.sessionId, { preferences: [{ id: served!.id }] }, NOW.toISOString());

    const outcome = await new PreferenceInferenceStage().run(
      await context(episodeId, () => ({
        preferences: [
          {
            text: served!.text,
            grounds: ['S1'],
            scope: 'standing',
            confidence: 0.9,
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.preferences).toBe(0);
    expect(outcome.summary).toContain('already served this session');

    const after = await readPreference(harness.driver, served!.id);
    expect(after?.observations).toBe(2);
  }, 300_000);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContextVectorStage } from './context-vectors.js';
import { ReflectiveSynthesisStage } from './synthesis.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { DERIVES_FROM_TYPE } from '../../../infrastructure/graph/narrative-queries.js';
import { ALTERNATIVE_TYPE } from '../../../infrastructure/graph/relationships.js';
import { readSynthesis, SYNTHESIS_LABEL } from '../../../infrastructure/graph/synthesis-queries.js';
import {
  contextVector,
  countOpenEdgesInto,
  countOutgoingEdges,
  nodeLabels,
  supersedingNodeIds,
  synthesisDrawnOver,
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
import { SessionManager } from '../../../session/session-manager.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';
import { directIntakePublisher } from '../../test-support/direct-intake.fixture.js';
import { derivedNode, publishDerivedNodeEvidence } from '../derived-node-evidence.js';
import { handleReflection, type ReflectionIntakeDeps } from '../intake.js';
import { LaneAssigner } from '../lanes.js';
import { activatedCoordinator } from '../test-support/publication-substrate.fixture.js';

/**
 * The synthesis lifecycle against real stores, with the model's answer injected.
 *
 * What the injection buys is the part a live call cannot pin: whether a replacement really
 * closes the earlier conclusion and leaves it reachable, and whether an alternative really
 * leaves both standing. The live run is a separate exercise and answers a different question.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-09-13T12:00:00.000Z');

/** Two vectors on one basis are cosine 1, so the neighbourhood read is about the query and not the embedder. */
function basisVector(index: number): Vector {
  return Array.from({ length: DIMENSION }, (_, slot) => (slot === index ? 1 : 0));
}

/** One basis per case, so a case's neighbourhood is its own claims and nothing another case seeded. */
const BASES = {
  drawn: basisVector(3),
  repeat: basisVector(9),
  replace: basisVector(17),
  alternative: basisVector(25),
} as const;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let publications: PublicationCoordinator;
let intake: ReflectionIntakeDeps;

function provider(basis: Vector, generate: () => unknown): Provider {
  return {
    embed: (texts: readonly string[]): Promise<Vector[]> => Promise.resolve(texts.map(() => basis)),
    generate: () => Promise.resolve(generate()),
  };
}

async function newEpisode(identity: string, text: string): Promise<string> {
  const stored = await handleReflection(intake, { turns: [{ role: 'user', text }] }, { identity });
  return stored.episode_id;
}

/**
 * A claim written straight onto its episode with a chosen vector, plus the durable record of
 * where it came from. Both halves are needed: the stage reads the vector to find neighbours and
 * the records to say what stands behind the conclusion it draws.
 */
async function seedClaim(episodeId: string, text: string, basis: Vector): Promise<string> {
  const written = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Insight',
    text,
    contentVector: basis,
    occurredAt: NOW,
    now: NOW,
  });
  const recorded = await publishDerivedNodeEvidence(
    { publications, now: NOW },
    {
      subject: episodeId,
      nodes: [
        derivedNode({
          nodeId: written.node.id,
          role: 'extraction',
          relationType: written.edge.type,
          relationId: written.edge.id,
          sourceId: episodeId,
          minted: written.created,
        }),
      ],
    },
  );
  expect(recorded.status).toBe('published');
  return written.node.id;
}

async function context(
  episodeId: string,
  basis: Vector,
  generate: () => unknown,
): Promise<StageContext> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  expect(episode).toBeDefined();
  return {
    driver: harness.driver,
    db,
    provider: provider(basis, generate),
    episodeId,
    episode: episode!,
    logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
    publications,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-synthesis-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
  // Before anything publishes: initialization refuses a pairing that already carries history.
  publications = await activatedCoordinator({ driver: harness.driver, db, logger }, 'synthesis');

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

describe('ReflectiveSynthesisStage over real stores', () => {
  it('draws a conclusion across two episodes and makes it a citizen of the graph', async () => {
    const earlier = await newEpisode(
      'synthesis-new-a',
      'the nightly sync finished in four minutes',
    );
    const older = await seedClaim(
      earlier,
      'the nightly sync finishes in about four minutes',
      BASES.drawn,
    );
    const later = await newEpisode('synthesis-new-b', 'the nightly sync took nineteen minutes');
    const fresh = await seedClaim(
      later,
      'the nightly sync took nineteen minutes last night',
      BASES.drawn,
    );

    const outcome = await new ReflectiveSynthesisStage().run(
      await context(later, BASES.drawn, () => ({
        conclusions: [
          {
            text: 'the nightly sync has slowed by roughly five times since it was last measured',
            premises: ['M1', 'M2'],
            inference: 'new',
            confidence: 0.8,
            rationale: 'both memories measure the same job',
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.counts?.synthesis).toBe(1);

    const drawnId = await synthesisDrawnOver(harness.driver, [fresh, older]);
    expect(drawnId).toBeDefined();
    const drawn = await readSynthesis(harness.driver, drawnId!);
    expect(drawn?.inferred).toBe(true);
    expect(drawn?.standing).toBe('sole');
    expect(drawn?.premises).toEqual(
      expect.arrayContaining(['the nightly sync took nineteen minutes last night']),
    );
    expect(await nodeLabels(harness.driver, drawnId!)).toEqual(
      expect.arrayContaining([SYNTHESIS_LABEL, 'Memory', 'AionNode']),
    );
    expect(await countOutgoingEdges(harness.driver, DERIVES_FROM_TYPE, drawnId!)).toBe(2);

    // The conclusion is only a resonant citizen if the stage that follows it can reach it. The
    // pipeline runs context vectors after synthesis for exactly this.
    const vectors = await new ContextVectorStage().run(
      await context(later, BASES.drawn, () => ({})),
    );
    expect(vectors.status).toBe('ok');
    expect(await contextVector(harness.driver, drawnId!)).toBeDefined();
  }, 300_000);

  it('reads the same neighbourhood once at the same revisions', async () => {
    const episodeId = await newEpisode('synthesis-repeat-a', 'the export job writes to S3');
    await seedClaim(episodeId, 'the export job writes its output to S3', BASES.repeat);
    const second = await newEpisode('synthesis-repeat-b', 'the export job writes to GCS now');
    await seedClaim(second, 'the export job writes its output to GCS', BASES.repeat);

    const answer = (): unknown => ({ conclusions: [] });
    const first = await new ReflectiveSynthesisStage().run(
      await context(second, BASES.repeat, answer),
    );
    const repeat = await new ReflectiveSynthesisStage().run(
      await context(second, BASES.repeat, answer),
    );

    expect(first.status).toBe('ok');
    expect(repeat).toEqual(
      expect.objectContaining({
        status: 'skipped',
        summary: 'this neighbourhood was already read at these revisions',
      }),
    );
  }, 300_000);

  it('replaces an earlier conclusion and leaves it standing as what was replaced', async () => {
    const first = await newEpisode('synthesis-replace-a', 'the retry limit is three');
    const firstClaim = await seedClaim(first, 'the retry limit is three attempts', BASES.replace);
    const second = await newEpisode('synthesis-replace-b', 'the retry limit is three everywhere');
    const secondClaim = await seedClaim(
      second,
      'the retry limit is three attempts in every lane',
      BASES.replace,
    );

    await new ReflectiveSynthesisStage().run(
      await context(second, BASES.replace, () => ({
        conclusions: [
          {
            text: 'the retry limit is uniform across the system',
            premises: ['M1', 'M2'],
            inference: 'new',
            confidence: 0.7,
          },
        ],
      })),
    );
    const originalId = await synthesisDrawnOver(harness.driver, [secondClaim, firstClaim]);
    expect(originalId).toBeDefined();

    const third = await newEpisode('synthesis-replace-c', 'the ingest lane retries five times');
    await seedClaim(third, 'the ingest lane retries five times, not three', BASES.replace);

    const outcome = await new ReflectiveSynthesisStage().run(
      await context(third, BASES.replace, () => ({
        conclusions: [
          {
            text: 'the retry limit is per lane, and the ingest lane is the exception',
            premises: ['M1', 'M2'],
            inference: 'replaces',
            revises: 'C1',
            confidence: 0.8,
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toContain('replacing an earlier reading');

    const replaced = await readSynthesis(harness.driver, originalId!);
    expect(replaced?.closedAt).toBeDefined();
    expect(replaced?.text).toBe('the retry limit is uniform across the system');

    const successors = await supersedingNodeIds(harness.driver, originalId!);
    expect(successors).toHaveLength(1);
    const successor = await readSynthesis(harness.driver, successors[0]!);
    expect(successor?.text).toBe(
      'the retry limit is per lane, and the ingest lane is the exception',
    );
    expect(successor?.closedAt).toBeUndefined();
    expect(successor?.premises).toContain('the ingest lane retries five times, not three');
  }, 300_000);

  it('keeps a second reading beside the first and marks both contested', async () => {
    const first = await newEpisode('synthesis-alt-a', 'the queue drains slowly after deploys');
    const firstClaim = await seedClaim(
      first,
      'the queue drains slowly after every deploy',
      BASES.alternative,
    );
    const second = await newEpisode('synthesis-alt-b', 'deploys restart the workers');
    const secondClaim = await seedClaim(
      second,
      'a deploy restarts every worker process',
      BASES.alternative,
    );

    await new ReflectiveSynthesisStage().run(
      await context(second, BASES.alternative, () => ({
        conclusions: [
          {
            text: 'the drain slows because a deploy restarts the workers',
            premises: ['M1', 'M2'],
            inference: 'new',
            confidence: 0.6,
          },
        ],
      })),
    );
    const originalId = await synthesisDrawnOver(harness.driver, [secondClaim, firstClaim]);
    expect(originalId).toBeDefined();

    const third = await newEpisode('synthesis-alt-c', 'deploys also clear the page cache');
    await seedClaim(third, 'a deploy also clears the page cache', BASES.alternative);

    const outcome = await new ReflectiveSynthesisStage().run(
      await context(third, BASES.alternative, () => ({
        conclusions: [
          {
            text: 'the drain slows because a deploy clears the page cache',
            premises: ['M1', 'M2'],
            inference: 'alternative',
            revises: 'C1',
            confidence: 0.6,
          },
        ],
      })),
    );

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toContain('standing beside one');

    const kept = await readSynthesis(harness.driver, originalId!);
    expect(kept?.closedAt).toBeUndefined();
    expect(kept?.standing).toBe('contested');

    // The type is undirected, so the edge is stored in one canonical direction and the case
    // counts both ends rather than guessing which id sorted first.
    const outgoing = await countOutgoingEdges(harness.driver, ALTERNATIVE_TYPE, originalId!);
    const incoming = await countOpenEdgesInto(harness.driver, ALTERNATIVE_TYPE, originalId!);
    expect(outgoing + incoming).toBe(1);
  }, 300_000);
});

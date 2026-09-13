import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ReflectiveSynthesisStage } from './synthesis.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  readSynthesis,
  type StoredSynthesis,
} from '../../../infrastructure/graph/synthesis-queries.js';
import { synthesisDrawnOver } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { ProviderRouter } from '../../../infrastructure/providers/role-provider.js';
import { GenerationSpendGuard } from '../../../infrastructure/providers/spending.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
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
 * The named live exercise: one real cross-episode tension read by the shipped model, then the
 * same neighbourhood read again after a capture that contradicts what it concluded.
 *
 * Everything here is the shipped path. The router is the service's own, the spending guard holds
 * against the same day's ceiling the service holds against, the frame reaches the model through
 * the same request builder, and the stage is the one the pipeline registers. What the run reports
 * is what the model actually said, printed rather than asserted on wording: the assertions are
 * about the lifecycle, which is that a conclusion is drawn with premises from more than one
 * episode, and that the later capture moves that conclusion's standing rather than leaving two
 * unrelated nodes side by side.
 */

const API_KEY = process.env.AION_ANTHROPIC_API_KEY ?? '';
const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-09-13T12:00:00.000Z');

/**
 * A real tension across two episodes: the same job, measured twice, with the second measurement
 * an order of magnitude off the first and a third capture naming a cause that makes the drawn
 * conclusion wrong rather than merely old.
 *
 * All three are worded about the same subject in the same terms on purpose. The neighbourhood is
 * nominated by content vector against `AION_REFLECTION_SYNTHESIS_NEIGHBOUR_THRESHOLD`, and how
 * far that floor reaches across paraphrase is a property of the embedder rather than of this
 * lifecycle; a capture that never joins the neighbourhood is not a revision the pass declined.
 */
const EARLIER = 'the nightly reconciliation finished in four minutes, as it has all quarter';
const LATER = 'the nightly reconciliation took fifty-one minutes last night';
const CONTRADICTING =
  'the nightly reconciliation took fifty-one minutes only because the index rebuild made it re-scan every row, and it finished in four minutes again tonight';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let publications: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let provider: Provider;

async function newEpisode(identity: string, text: string): Promise<string> {
  const stored = await handleReflection(intake, { turns: [{ role: 'user', text }] }, { identity });
  return stored.episode_id;
}

/** A claim on its episode, embedded by the same local model the substrate uses, with its record. */
async function seedClaim(episodeId: string, text: string): Promise<string> {
  const [vector] = await provider.embed([text]);
  const written = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Insight',
    text,
    ...(vector === undefined ? {} : { contentVector: vector }),
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

async function context(episodeId: string): Promise<StageContext> {
  const episode = await loadEpisodeContext(harness.driver, episodeId);
  expect(episode).toBeDefined();
  return {
    driver: harness.driver,
    db,
    provider,
    episodeId,
    episode: episode!,
    logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
    publications,
  };
}

function describeConclusion(label: string, stored: StoredSynthesis | undefined): void {
  if (stored === undefined) {
    console.log(`${label}: nothing drawn`);
    return;
  }
  console.log(
    `${label}: "${stored.text}" (confidence ${stored.confidence.toFixed(2)},` +
      ` standing ${stored.standing}, ${stored.closedAt === undefined ? 'open' : 'closed'},` +
      ` premises ${String(stored.premises.length)})`,
  );
}

beforeAll(async () => {
  if (API_KEY === '') {
    return;
  }
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-synthesis-live-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
  publications = await activatedCoordinator(
    { driver: harness.driver, db, logger },
    'synthesis-live',
  );

  const config = loadConfig({
    AION_ANTHROPIC_API_KEY: API_KEY,
    AION_OLLAMA_URL: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  });
  // The shipped guard, over this run's own store: the demonstration spends against a day's
  // ceiling exactly as the service does, and a run that would cross it is refused here too.
  const router = new ProviderRouter({
    config,
    spending: new GenerationSpendGuard({ db, ceilingUsd: config.anthropic.dailyCeilingUsd }),
  });
  provider = router.forRole('reflect');

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
  if (API_KEY === '') {
    return;
  }
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(API_KEY === '')('the synthesis lifecycle, live', () => {
  it('draws a conclusion across two episodes, then revises it when the evidence changes', async () => {
    const first = await newEpisode('synthesis-live-a', EARLIER);
    const firstClaim = await seedClaim(first, EARLIER);
    const second = await newEpisode('synthesis-live-b', LATER);
    const secondClaim = await seedClaim(second, LATER);

    const drawn = await new ReflectiveSynthesisStage().run(await context(second));
    console.log(`initial pass: ${drawn.status} — ${drawn.summary}`);
    expect(drawn.status).toBe('ok');
    expect(drawn.counts?.synthesis).toBeGreaterThan(0);

    const originalId = await synthesisDrawnOver(harness.driver, [secondClaim, firstClaim]);
    expect(originalId).toBeDefined();
    const original = await readSynthesis(harness.driver, originalId!);
    describeConclusion('conclusion', original);

    // Drawn across episodes and distinct from either of them: a conclusion that restated one of
    // its premises would be a duplicate of a claim the substrate already holds.
    expect(original?.inferred).toBe(true);
    expect(original?.premises.length).toBeGreaterThanOrEqual(2);
    expect(original?.text).not.toBe(EARLIER);
    expect(original?.text).not.toBe(LATER);

    const third = await newEpisode('synthesis-live-c', CONTRADICTING);
    await seedClaim(third, CONTRADICTING);

    const revised = await new ReflectiveSynthesisStage().run(await context(third));
    console.log(`changed-evidence pass: ${revised.status} — ${revised.summary}`);
    expect(revised.status).toBe('ok');

    const after = await readSynthesis(harness.driver, originalId!);
    describeConclusion('conclusion after the contradicting capture', after);

    // The lifecycle, not the wording: the earlier conclusion's standing moved. Either it was
    // replaced, which closes it and links the replacement back to it, or a second reading was
    // linked to it and both are marked contested. A pass that drew an unrelated node beside it
    // and changed nothing about it is what this refuses.
    const replaced = after?.closedAt !== undefined;
    const contested = after?.standing === 'contested';
    expect(replaced || contested).toBe(true);
  }, 600_000);
});

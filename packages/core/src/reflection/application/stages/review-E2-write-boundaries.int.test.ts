import * as selectedReading from '../../../infrastructure/graph/selected-reading.js';
import { writeRedactedProperties } from '../../../infrastructure/graph/redaction-residue-writes.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PreferenceInferenceStage } from './preferences.js';
import { supersede } from '../../../infrastructure/graph/bitemporal.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { nodeCandidates } from '../../../infrastructure/graph/seed-queries.js';
import {
  writePreference,
  readPreference,
  findStandingPreferences,
} from '../../../infrastructure/graph/preference-queries.js';
import { readMemberId, bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { assemble, item } from '../../../recall/domain/test-support/pack.fixture.js';
import { ReflectiveSynthesisStage } from './synthesis.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { readSynthesis, writeSynthesis } from '../../../infrastructure/graph/synthesis-queries.js';
import { synthesisDrawnOver } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
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

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-09-13T12:00:00.000Z');

/** Two vectors on one basis are cosine 1, so the neighbourhood read is about the query and not the embedder. */
function basisVector(index: number): Vector {
  return Array.from({ length: DIMENSION }, (_, slot) => (slot === index ? 1 : 0));
}

/** One basis per case, so a case's neighbourhood is its own claims and nothing another case seeded. */
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
  dataDir = mkdtempSync(join(tmpdir(), 'aion-E-review-'));
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

describe('the selected reading survives through publication', () => {
  it('refuses a premise whose actual text was rewritten during generation', async () => {
    const basis = basisVector(71);
    const ep = await newEpisode(
      'E2-rewrite-old',
      'a retained explanation about the connection pool',
    );
    const old = await seedClaim(ep, 'the pool uses the original retained explanation', basis);
    const freshEp = await newEpisode(
      'E2-rewrite-new',
      'the pool behaves consistently with that explanation',
    );
    const fresh = await seedClaim(
      freshEp,
      'the pool behaves consistently with that explanation',
      basis,
    );
    const outcome = await new ReflectiveSynthesisStage().run(
      await context(freshEp, basis, async () => {
        expect(
          await writeRedactedProperties(
            harness.driver,
            [{ id: old, properties: { text: '[REDACTED]' } }],
            NOW,
          ),
        ).toContain(old);
        return {
          conclusions: [
            {
              text: 'the original retained explanation accounts for the pool behavior',
              premises: ['M1', 'M2'],
              inference: 'new',
            },
          ],
        };
      }),
    );
    const written = await synthesisDrawnOver(harness.driver, [fresh, old]);
    console.log(JSON.stringify({ case: 'rewritten-selected-text', outcome, written }));
    expect(outcome.counts?.synthesis ?? 0).toBe(0);
    expect(written).toBeUndefined();
  }, 300_000);

  it('serializes a selected-premise retirement through the final read and write', async () => {
    const basis = basisVector(77);
    const first = await newEpisode('E2-late-old', 'the pool has ten busy connections');
    const old = await seedClaim(first, 'the pool has ten busy connections', basis);
    const second = await newEpisode('E2-late-new', 'new requests wait for a connection');
    const fresh = await seedClaim(second, 'new requests wait for a connection', basis);
    const third = await newEpisode('E2-late-correction', 'a correction to the pool size');
    const replacement = await seedClaim(third, 'a correction to the pool size', basisVector(78));
    let announce: () => void = () => {};
    let release: () => void = () => {};
    const read = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = selectedReading.movedSinceRead;
    let intercepted = false;
    const spy = vi
      .spyOn(selectedReading, 'movedSinceRead')
      .mockImplementation(async (tx, reading) => {
        const moved = await real(tx, reading);
        if (!intercepted && reading.some((row) => row.id === old)) {
          intercepted = true;
          announce();
          await resumed;
        }
        return moved;
      });
    try {
      const publishing = new ReflectiveSynthesisStage().run(
        await context(second, basis, () => ({
          conclusions: [
            {
              text: 'all available pool capacity is occupied',
              premises: ['M1', 'M2'],
              inference: 'new',
            },
          ],
        })),
      );
      await read;
      const retiring = supersede(harness.driver, { oldId: old, newId: replacement, now: NOW });
      const retiredBeforeRelease = await Promise.race([
        retiring.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 300);
        }),
      ]);
      release();
      const outcome = await publishing;
      await retiring;
      console.log(
        JSON.stringify({ case: 'retired-after-selected-check', retiredBeforeRelease, outcome }),
      );
      if (retiredBeforeRelease) {
        expect(outcome.counts?.synthesis ?? 0).toBe(0);
        expect(await synthesisDrawnOver(harness.driver, [old, fresh])).toBeUndefined();
      } else {
        // Locking is valid too: publication linearizes before the later retirement.
        expect(outcome.counts?.synthesis).toBe(1);
      }
    } finally {
      release();
      spy.mockRestore();
    }
  }, 300_000);
});

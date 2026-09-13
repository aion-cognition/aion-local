import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

describe('inference boundaries through real stores and injected answers', () => {
  it('reconsiders a prior conclusion reached by an explicit correction below the cosine floor', async () => {
    const basis = basisVector(63);
    const earlier = await newEpisode(
      'E-linked-a',
      'the nightly reconciliation normally takes four minutes',
    );
    const a = await seedClaim(
      earlier,
      'the nightly reconciliation normally takes four minutes',
      basis,
    );
    const later = await newEpisode(
      'E-linked-b',
      'the nightly reconciliation took fifty-one minutes',
    );
    const b = await seedClaim(later, 'the nightly reconciliation took fifty-one minutes', basis);
    const priorText = 'the reconciliation has become much slower than its established pattern';
    await writeSynthesis(harness.driver, {
      text: priorText,
      textNorm: priorText,
      premiseIds: [a, b],
      premiseTexts: [
        'the nightly reconciliation normally takes four minutes',
        'the nightly reconciliation took fifty-one minutes',
      ],
      confidence: 0.8,
      rationale: '',
      occurredAt: NOW,
      now: NOW,
      contentVector: basis,
    });
    const corrected = await newEpisode(
      'E-linked-c',
      'that measurement included a one-off rebuild, ordinary runtime remains unchanged',
    );
    const c = await seedClaim(
      corrected,
      'that measurement included a one-off rebuild, ordinary runtime remains unchanged',
      basisVector(64),
    );
    await supersede(harness.driver, { oldId: b, newId: c, now: NOW });
    let calls = 0;
    let prompt = '';
    const ctx = await context(corrected, basisVector(64), () => ({}));
    const outcome = await new ReflectiveSynthesisStage().run({
      ...ctx,
      provider: {
        ...ctx.provider,
        generate: async (request) => {
          calls += 1;
          prompt = JSON.stringify(request.messages);
          return { conclusions: [] };
        },
      },
    });
    console.log(JSON.stringify({ case: 'linked-reconsideration', outcome, calls, prompt }));
    expect(calls).toBe(1);
    expect(prompt).toContain(priorText);
  }, 300_000);

  for (const move of [false, true]) {
    it(`publishes only from the premises it read (premise retired during generation: ${String(move)})`, async () => {
      const basis = basisVector(move ? 48 : 47);
      const first = await newEpisode(
        `E-proof-a-${String(move)}`,
        'the pool is capped at ten connections',
      );
      const older = await seedClaim(first, 'the pool is capped at ten connections', basis);
      const second = await newEpisode(
        `E-proof-b-${String(move)}`,
        'all ten connections remain busy',
      );
      const fresh = await seedClaim(second, 'all ten connections remain busy', basis);
      const ctx = await context(second, basis, async () => {
        if (move) {
          const replacementEpisode = await newEpisode(
            'E-proof-new',
            'the pool actually has a hundred connections',
          );
          const replacement = await seedClaim(
            replacementEpisode,
            'the pool has a hundred idle connections',
            basisVector(49),
          );
          await supersede(harness.driver, {
            oldId: fresh,
            newId: replacement,
            now: new Date(NOW.getTime() + 1),
          });
        }
        return {
          conclusions: [
            {
              text: 'All available connections are exhausted',
              premises: ['M1', 'M2'],
              inference: 'new',
              confidence: 0.8,
            },
          ],
        };
      });
      const outcome = await new ReflectiveSynthesisStage().run(ctx);
      const written = await synthesisDrawnOver(harness.driver, [fresh, older]);
      console.log(JSON.stringify({ case: 'selected-premise', move, outcome, written }));
      if (move) {
        expect(outcome.counts?.synthesis ?? 0).toBe(0);
        expect(written).toBeUndefined();
      } else {
        expect(outcome.counts?.synthesis).toBe(1);
        expect(written).toBeDefined();
      }
    }, 300_000);
  }

  it('lets the model read an explicit working habit contained in one captured line', async () => {
    const episodeId = await newEpisode(
      'E-single-preference',
      'Across every review I ask for the failing case first, then the patch, then the passing case. I have repeated this instruction for years; preserve it as my default review style.',
    );
    let calls = 0;
    const ctx = await context(episodeId, basisVector(53), () => {
      calls += 1;
      return {
        preferences: [
          {
            text: 'asks to see the failure before reviewing its fix',
            grounds: ['S1'],
            scope: 'standing',
            confidence: 0.8,
          },
        ],
      };
    });
    const outcome = await new PreferenceInferenceStage().run(ctx);
    console.log(JSON.stringify({ case: 'one-line-habit', calls, outcome }));
    expect(calls).toBe(1);
    expect(outcome.counts?.preferences).toBe(1);
  }, 300_000);

  it('preserves both contextual meanings of the same model-generated preference wording', async () => {
    const memberId = await readMemberId(harness.driver);
    expect(memberId).toBeDefined();
    const common = {
      memberId: memberId!,
      text: 'prefers a concise summary',
      textNorm: 'prefers a concise summary',
      roles: ['user'],
      scope: 'contextual',
      confidence: 0.8,
      occurredAt: NOW,
      now: NOW,
    };
    const first = await newEpisode('E-context-a', 'I want short summaries in code review');
    const firstCtx = await loadEpisodeContext(harness.driver, first);
    const a = await writePreference(harness.driver, {
      ...common,
      groundIds: [firstCtx!.turns[0]!.id],
      context: 'code review',
    });
    const second = await newEpisode('E-context-b', 'I want short summaries in incident handoff');
    const secondCtx = await loadEpisodeContext(harness.driver, second);
    const b = await writePreference(harness.driver, {
      ...common,
      groundIds: [secondCtx!.turns[0]!.id],
      context: 'incident handoff',
    });
    const stored = await Promise.all(
      [...new Set([a.id, b.id])].map((id) => readPreference(harness.driver, id)),
    );
    console.log(JSON.stringify({ case: 'context-identity', a, b, stored }));
    expect(JSON.stringify(stored)).toContain('code review');
    expect(JSON.stringify(stored)).toContain('incident handoff');
  }, 300_000);

  it('carries a contextual preference condition into the model input and the served pack', async () => {
    const memberId = await readMemberId(harness.driver);
    const episode = await newEpisode(
      'E-context-serve',
      'Skip the approval for local throwaway test stores only.',
    );
    const ctx = await loadEpisodeContext(harness.driver, episode);
    const written = await writePreference(harness.driver, {
      memberId: memberId!,
      text: 'does not require approval',
      textNorm: 'does not require approval',
      groundIds: [ctx!.turns[0]!.id],
      roles: ['user'],
      scope: 'contextual',
      context: 'local throwaway test stores only',
      confidence: 0.8,
      occurredAt: NOW,
      now: NOW,
    });
    const prior = (await findStandingPreferences(harness.driver, 12)).find(
      (row) => row.id === written.id,
    );
    const candidates = await nodeCandidates(harness.driver, {
      ids: [written.id],
      mode: withCurrency(NOW),
    });
    expect(candidates).toHaveLength(1);
    const pack = assemble([{ ...item(written.id), ...candidates[0]! }]);
    console.log(JSON.stringify({ case: 'context-serving', prior, pack }));
    expect.soft(JSON.stringify(prior)).toContain('local throwaway test stores only');
    expect.soft(pack.rendered_text).toContain('local throwaway test stores only');
  }, 300_000);

  it('discloses contested synthesis when only one of the competing conclusions is served', async () => {
    const basis = basisVector(59);
    const e = await newEpisode('E-contested-a', 'the queue slows after deployments');
    const a = await seedClaim(e, 'deployments restart the workers', basis);
    const e2 = await newEpisode('E-contested-b', 'deployments clear the cache');
    const b = await seedClaim(e2, 'deployments clear the page cache', basis);
    const common = {
      premiseIds: [a, b],
      premiseTexts: ['deployments restart the workers', 'deployments clear the page cache'],
      confidence: 0.6,
      rationale: '',
      occurredAt: NOW,
      now: NOW,
      contentVector: basis,
    };
    const first = await writeSynthesis(harness.driver, {
      ...common,
      text: 'worker restarts explain the slowdown',
      textNorm: 'worker restarts explain the slowdown',
    });
    await writeSynthesis(harness.driver, {
      ...common,
      text: 'a cold cache explains the slowdown',
      textNorm: 'a cold cache explains the slowdown',
      revises: { kind: 'alternative', priorId: first.id },
    });
    expect((await readSynthesis(harness.driver, first.id))?.standing).toBe('contested');
    const candidates = await nodeCandidates(harness.driver, {
      ids: [first.id],
      mode: withCurrency(NOW),
    });
    expect(candidates).toHaveLength(1);
    const pack = assemble([{ ...item(first.id), ...candidates[0]! }]);
    console.log(JSON.stringify({ case: 'contested-serving', pack }));
    expect(pack.rendered_text).toContain('contested');
  }, 300_000);
});

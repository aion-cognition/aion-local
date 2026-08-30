import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { listSupersessionProposals } from '../../../infrastructure/sqlite/supersession-proposals.js';
import { SessionManager } from '../../../session/session-manager.js';
import { ReflectionDispatch } from '../../../reflection/application/dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { SUPERSESSION_STAGE_NAME } from '../../../reflection/application/stages/supersession.js';
import { stageLedgerKey } from '../../../reflection/domain/stage.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import { retroJudgmentSweepOperation } from './retro-judgment-sweep-operation.js';

/**
 * The backlog this operation drains never went through the orchestrator's own supersession
 * stage, so intake (which writes only Episode/Turn nodes) plus a direct cognitive-node write
 * models that backlog exactly: the `reflection:stage:supersession:{episodeId}` key is never
 * set until this operation sets it.
 */

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let live: Provider;
let priorEpisodeId: string;
let nextEpisodeId: string;
let priorFactId: string;
let nextFactId: string;

const PRIOR_TEXT = 'The retry limit for the ingest worker is three attempts.';
const NEXT_TEXT = 'Raise the ingest worker retry limit from three to seven attempts.';

/** Answers every judgment the same way, so this file tests scheduling, not judgment quality. */
function stubProvider(calls: StructuredRequest[]): Provider {
  return {
    embed: async () => [],
    generate: async (req: StructuredRequest) => {
      calls.push(req);
      return { contradicts: true, confidence: 1, rationale: 'stubbed for the sweep test' };
    },
  };
}

const config: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, retroSupersessionBatch: 10 },
};

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-retro-sweep-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  live = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: live,
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };

  const prior = await handleReflection(
    intake,
    { turns: [{ role: 'assistant', text: PRIOR_TEXT }], summary: 'retry baseline' },
    { identity: 'mcp-retro-sweep-prior' },
  );
  const next = await handleReflection(
    intake,
    { turns: [{ role: 'assistant', text: NEXT_TEXT }], summary: 'retry revised' },
    { identity: 'mcp-retro-sweep-next' },
  );
  priorEpisodeId = prior.episode_id;
  nextEpisodeId = next.episode_id;

  const now = new Date();
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name: 'ingest worker retry limit',
        nameNorm: 'ingest worker retry limit',
        type: 'concept',
        text: 'ingest worker retry limit (concept)',
        sourceEpisodeId: nextEpisodeId,
        extractionMethod: 'test-seed',
        confidence: 1,
      },
    ],
    now,
  );
  for (const episodeId of [priorEpisodeId, nextEpisodeId]) {
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [entity!.id],
      now,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }

  const [priorVector, nextVector] = await live.embed([PRIOR_TEXT, NEXT_TEXT]);
  const priorNode = await writeCognitiveNode(harness.driver, {
    episodeId: priorEpisodeId,
    label: 'Concept',
    text: PRIOR_TEXT,
    contentVector: priorVector,
    now,
  });
  const nextNode = await writeCognitiveNode(harness.driver, {
    episodeId: nextEpisodeId,
    label: 'Decision',
    text: NEXT_TEXT,
    contentVector: nextVector,
    now,
  });
  priorFactId = priorNode.node.id;
  nextFactId = nextNode.node.id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function contextFor(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    health: healthFixture(),
    now: new Date(),
    signal: new AbortController().signal,
  };
}

describe('retroJudgmentSweepOperation against a live graph', () => {
  it('never faced the supersession stage before the sweep runs', () => {
    expect(isLedgerApplied(db, stageLedgerKey(SUPERSESSION_STAGE_NAME, priorEpisodeId))).toBe(false);
    expect(isLedgerApplied(db, stageLedgerKey(SUPERSESSION_STAGE_NAME, nextEpisodeId))).toBe(false);
  });

  it('proposes rather than closing, and marks both episodes swept', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await retroJudgmentSweepOperation({ buildProvider: () => stubProvider(calls) }).run(
      contextFor(),
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(calls.length).toBeGreaterThan(0);

    // Propose-only: the pair judged "contradicts" produced a proposal row, not a graph close.
    const proposals = listSupersessionProposals(db);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((row) => row.resolvedAt === null)).toBe(true);
    expect(proposals.some((row) => row.oldId === priorFactId || row.oldId === nextFactId)).toBe(true);

    const priorFactProps = await nodeProperties(harness.driver, priorFactId);
    expect(priorFactProps[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();

    expect(isLedgerApplied(db, stageLedgerKey(SUPERSESSION_STAGE_NAME, priorEpisodeId))).toBe(true);
    expect(isLedgerApplied(db, stageLedgerKey(SUPERSESSION_STAGE_NAME, nextEpisodeId))).toBe(true);
  }, 180_000);

  it('converges: a second run finds nothing left in the backlog', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await retroJudgmentSweepOperation({ buildProvider: () => stubProvider(calls) }).run(
      contextFor(),
    );

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(calls.length).toBe(0);
  }, 60_000);
});

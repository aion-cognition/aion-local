import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  probeRecall,
  recallProbeLedgerKey,
  recallProbeOperation,
  RECALL_PROBE_IDENTITY,
} from './recall-probe.js';
import { commitIncidence } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { linkEntityMentions } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { fulltextSeeds } from '../../../infrastructure/graph/seed-queries.js';
import { accessMetadata } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../../infrastructure/sqlite/coverage-contract.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../../infrastructure/sqlite/last-pack.js';
import { packMethodCounters } from '../../../infrastructure/sqlite/method-counters.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  completeSourceWork,
  listStageWork,
  readActiveGeneration,
  stageWorkId,
} from '../../../infrastructure/sqlite/processing-generations.js';
import { publishReadinessPolicy } from '../../../infrastructure/sqlite/readiness-policies.js';
import { recallCadenceCounters } from '../../../infrastructure/sqlite/recall-cadence.js';
import { recallProbeReadingV2 } from '../../../infrastructure/sqlite/recall-probe-counters.js';
import { countReinforcementSignals } from '../../../infrastructure/sqlite/reinforcement-queue.js';
import { readServedItems, recordServedItems } from '../../../infrastructure/sqlite/served-items.js';
import { countUsageEvents } from '../../../infrastructure/sqlite/usage-events.js';
import { CueCache } from '../../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../../recall/application/recall.js';
import { RecallSideEffects } from '../../../recall/application/side-effects.js';
import { waitFor } from '../../../recall/application/test-support/wait-for.fixture.js';
import { handleReflection } from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { foldName } from '../../../reflection/domain/name-fold.js';
import { PIPELINE_VERSION } from '../../../reflection/domain/version.js';
import { directIntakePublisher } from '../../../reflection/test-support/direct-intake.fixture.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { OperationContext, RecallProbe } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The probe against a live substrate, and the isolation it promises. The first half asks
 * whether an experience stored two days ago comes back when the substrate is asked for it in
 * its own words. The second half is the part that matters more: a real recall is run beside the
 * probe over the same graph, so every mark the probe must not leave is one this file has just
 * watched a real recall leave.
 */

const EMBED_DIMENSION = 8;
/** The stage list this file's sources are accepted under. No pass runs them here. */
const REQUIRED_STAGES = ['entities', 'associations'];
const HORIZON = new Date('2026-09-01T00:00:00.000Z');
const STORED_AT = new Date('2026-09-03T10:00:00.000Z');
const YESTERDAY_AT = new Date('2026-09-04T18:00:00.000Z');
const PROBED_AT = new Date('2026-09-05T12:00:00.000Z');

const WRITE_SESSION = 'probe-int-write-session';
const READ_SESSION = 'probe-int-read-session';
/** A session still holding what it was served, which is what the served reading reads. */
const LONG_RUNNING_SESSION = 'probe-int-long-session';

const STORED_OBSERVATION =
  'we moved the ingestion service onto webhooks because polling missed too much';
/**
 * A backdated capture: it carries the same world date as the stored one and the substrate took
 * it at the probed moment. The sampler must leave it out, because acceptance is what it ages on.
 */
const FRESH_OBSERVATION = 'the standup moved to nine thirty on tuesdays';
const CUE = 'webhooks';

/** The entity a later episode names, which is what makes one served item referenced. */
const REFERENCED_ENTITY = 'entity-ingestion';
const UNREFERENCED_ENTITY = 'entity-forgotten';

function axis(index: number): Vector {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

/** The topic picks the axis, so what retrieval finds is a property of the fixture, not a model. */
function vectorFor(text: string): Vector {
  const lowered = text.toLowerCase();
  if (lowered.includes('webhook') || lowered.includes('ingestion')) {
    return axis(0);
  }
  if (lowered.includes('standup')) {
    return axis(1);
  }
  return axis(2);
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(vectorFor)),
  generate: () => Promise.resolve({ query_cues: [CUE], summary_cues: [], recent_turn_cues: [] }),
};

function config(overrides: Partial<Config['maintenance']> = {}): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    maintenance: { ...DEFAULTS.maintenance, ...overrides },
  };
}

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;
let recallDeps: RecallDeps;
let sideEffects: RecallSideEffects;
let probe: RecallProbe;
let storedEpisodeId: string;

function context(maintenance: Partial<Config['maintenance']> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config: config(maintenance),
    logger,
    provider,
    recallProbe: probe,
    health: healthFixture(),
    now: PROBED_AT,
    signal: new AbortController().signal,
  };
}

async function push(observation: string, now: Date, acceptedAt: Date = now): Promise<string> {
  const result = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions,
      provider,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      // The sampler ages on acceptance, so acceptance is what this fixture has to state. Left on
      // the wall clock every source is accepted at the moment the run happens, and the cut a
      // day behind the probed moment selects nothing at all.
      publications: directIntakePublisher(harness.driver, db, () => acceptedAt),
      acceptHookCapture: true,
    },
    { observations: [observation] },
    { identity: WRITE_SESSION, now },
  );
  return result.episode_id;
}

/**
 * Every stage the source's own accepted policy required, settled with the outcome a finished
 * pass records. Reading an empty stage list as a finished pass is what lets an unprocessed
 * source into the sample, so the policy is published before the push and each of its rows is
 * completed by name.
 */
function settlePolicyStages(sourceId: string, at: Date): void {
  const generation = readActiveGeneration(db, sourceId)?.processingGeneration;
  if (generation === undefined) {
    throw new Error(`source ${sourceId} was accepted without an active generation`);
  }
  for (const stageName of REQUIRED_STAGES) {
    completeSourceWork(
      db,
      stageWorkId(sourceId, generation, stageName),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      at,
    );
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-recall-probe-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  // Every covered read runs the coverage check first, the probe's source reads included. A
  // substrate whose control record cannot be read has answers that are all suspect, and the
  // probe reports that as an unavailable trial rather than as a miss.
  prepareCoverageContract(db, 1);
  activateCoverageContract(db, { activatedAt: HORIZON, fieldPolicyVersion: 1 });
  // Startup publishes the readiness contract before anything is accepted, and intake writes each
  // source's stage inventory from it. Accepted with none, a source records an inventory
  // obligation instead, and the sampler reads that as an unfinished pass.
  publishReadinessPolicy(
    db,
    { pipelineVersion: PIPELINE_VERSION, stageNames: REQUIRED_STAGES, transferCapabilities: [] },
    HORIZON,
  );

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });

  sideEffects = new RecallSideEffects(harness.driver, db, logger);
  recallDeps = {
    driver: harness.driver,
    db,
    sessions,
    provider,
    config: config(),
    cueCache: new CueCache(),
    logger,
    onRecalled: sideEffects.onRecalled,
  };
  probe = probeRecall(recallDeps);

  storedEpisodeId = await push(STORED_OBSERVATION, STORED_AT);
  await push(FRESH_OBSERVATION, STORED_AT, PROBED_AT);

  // The pass this substrate owes the stored source, finished the way a real one leaves it: every
  // stage the accepted policy named carries a typed outcome. That is what makes this source one
  // the probe may judge, and the fresh source keeps its own stages open.
  settlePolicyStages(storedEpisodeId, STORED_AT);
  // The extraction incidence the reflection worker records, which this file does not run. It is
  // what makes an emitted item one the records say the sampled source stands behind.
  commitIncidence(db, {
    sourceId: storedEpisodeId,
    nodeId: storedEpisodeId,
    role: 'extraction',
    operationId: 'extract-stored',
    at: STORED_AT,
  });

  // Two entities and an episode from yesterday that names one of them: the shape the
  // served-then-referenced reading measures.
  for (const id of [REFERENCED_ENTITY, UNREFERENCED_ENTITY]) {
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id,
      now: STORED_AT,
      occurredAt: STORED_AT,
      properties: { name: id, name_norm: foldName(id), type: 'project' },
    });
  }
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: 'episode-mentioning',
    now: YESTERDAY_AT,
    occurredAt: YESTERDAY_AT,
    properties: { text: 'more on ingestion', session_id: WRITE_SESSION },
  });
  await linkEntityMentions(harness.driver, {
    episodeId: 'episode-mentioning',
    entityIds: [REFERENCED_ENTITY],
    now: YESTERDAY_AT,
    confidence: 1,
    provenance: ['test-seed'],
  });
  // The durable half of that mention. The served reading is answered from the records now, so
  // an acknowledged incidence carrying a clock is what credits a later reference; the graph
  // edge beside it is what recall traverses.
  commitIncidence(db, {
    sourceId: 'episode-mentioning',
    nodeId: REFERENCED_ENTITY,
    role: 'mention',
    operationId: 'mention-later',
    at: YESTERDAY_AT,
  });
  recordServedItems(
    db,
    LONG_RUNNING_SESSION,
    [
      { itemId: REFERENCED_ENTITY, fingerprint: 'hash-1' },
      { itemId: UNREFERENCED_ENTITY, fingerprint: 'hash-2' },
    ],
    STORED_AT.toISOString(),
  );

  await waitFor('the fulltext index to cover the stored episode', async () => {
    const rows = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    return rows.some((row) => row.id === storedEpisodeId);
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the recall self-probe against a live substrate', () => {
  it('leaves the marks a real recall leaves, so the probe has something to be measured against', async () => {
    const pack = await handleRecall(
      recallDeps,
      { query: STORED_OBSERVATION },
      { identity: READ_SESSION, now: PROBED_AT },
    );
    await sideEffects.whenIdle();

    expect(pack.episodes?.map((item) => item.id)).toContain(storedEpisodeId);
    expect(getLastPack(db, READ_SESSION)).toBeDefined();
    expect(readServedItems(db, READ_SESSION).size).toBeGreaterThan(0);
    expect(recallCadenceCounters(db).totalCalls).toBe(1);
    expect((await accessMetadata(harness.driver, storedEpisodeId)).accessCount).toBeGreaterThan(0);
    expect(countUsageEvents(db)).toBeGreaterThan(0);
  }, 120_000);

  it('asks back what it was told and keeps the two outcomes apart', async () => {
    // The pass behind the sampled source is accounted for by name: every stage the accepted
    // policy required carries a typed outcome. An empty stage list would read as the same
    // thing, and it would mean nobody has ever run one.
    const generation = readActiveGeneration(db, storedEpisodeId)?.processingGeneration ?? 0;
    expect(listStageWork(db, storedEpisodeId, generation)).toEqual(
      // The read comes back in stage-name order, which is not the order the policy lists them in.
      [...REQUIRED_STAGES].sort().map((stageName) => ({
        stageName,
        state: 'completed',
        outcome: { outcome: 'complete', reason: 'accepted_pass_applied' },
      })),
    );

    const outcome = await recallProbeOperation().run(context());

    expect(outcome.status).toBe('applied');
    // Both sources carry the same world date and only one was accepted more than a day ago.
    // Acceptance is what decides the cut, not the date either of them claims.
    expect(outcome.itemsProcessed).toBe(1);
    expect(outcome.itemsAffected).toBe(1);

    const reading = recallProbeReadingV2(db);
    expect(reading.trials).toBe(1);
    expect(reading.sourceResolvable).toBe(1);
    expect(reading.sourceRelatedRetrieval).toBe(1);
    expect(reading.unavailable).toBe(0);
  }, 120_000);

  it('reads how much of what was served came back, and what it cannot date', () => {
    const { served } = recallProbeReadingV2(db);

    expect(served?.items).toBe(2);
    expect(served?.referenced).toBe(1);
    expect(served?.unversioned).toBe(0);
    expect(served?.measuredAt).toBe(PROBED_AT.toISOString());
  });

  it('records the run with the ids it asked about and nothing they said', () => {
    const entry = getLedgerEntry(db, recallProbeLedgerKey('2026-09-05'));
    const summary = entry?.summary as {
      readonly sources: readonly {
        readonly id: string;
        readonly resolvable: boolean;
        readonly relatedRetrieval: boolean;
      }[];
    };

    expect(summary.sources).toEqual([
      { id: storedEpisodeId, resolvable: true, relatedRetrieval: true },
    ]);
    expect(JSON.stringify(summary)).not.toContain(STORED_OBSERVATION);
  });

  /**
   * The whole point of the operation's construction. Every writer named here is one the test
   * above watched a real recall move, and the probe ran a full recall over the same graph
   * between the two readings.
   */
  it('leaves no mark of its own on the substrate it measured', async () => {
    const before = {
      cadence: recallCadenceCounters(db),
      methods: packMethodCounters(db),
      reinforcement: countReinforcementSignals(db),
      usage: countUsageEvents(db),
      access: (await accessMetadata(harness.driver, storedEpisodeId)).accessCount,
    };

    await recallProbeOperation().run(context());

    expect(recallCadenceCounters(db)).toEqual(before.cadence);
    expect(packMethodCounters(db)).toEqual(before.methods);
    expect(countReinforcementSignals(db)).toBe(before.reinforcement);
    expect(countUsageEvents(db)).toBe(before.usage);
    expect((await accessMetadata(harness.driver, storedEpisodeId)).accessCount).toBe(before.access);
    expect(getLastPack(db, RECALL_PROBE_IDENTITY)).toBeUndefined();
    expect(readServedItems(db, RECALL_PROBE_IDENTITY).size).toBe(0);
  }, 120_000);

  it('does nothing at all with AION_MAINTENANCE_RECALL_PROBE off', async () => {
    const outcome = await recallProbeOperation().run(context({ recallProbe: false }));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'recall probe disabled by AION_MAINTENANCE_RECALL_PROBE; nothing asked',
    });
  }, 60_000);
});

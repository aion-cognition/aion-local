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
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../../infrastructure/sqlite/last-pack.js';
import { packMethodCounters } from '../../../infrastructure/sqlite/method-counters.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { recallCadenceCounters } from '../../../infrastructure/sqlite/recall-cadence.js';
import { recallProbeCounters } from '../../../infrastructure/sqlite/recall-probe-counters.js';
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
const STORED_AT = new Date('2026-09-03T10:00:00.000Z');
const YESTERDAY_AT = new Date('2026-09-04T18:00:00.000Z');
const PROBED_AT = new Date('2026-09-05T12:00:00.000Z');

const WRITE_SESSION = 'probe-int-write-session';
const READ_SESSION = 'probe-int-read-session';
/** A session still holding what it was served, which is what the served reading reads. */
const LONG_RUNNING_SESSION = 'probe-int-long-session';

const STORED_OBSERVATION =
  'we moved the ingestion service onto webhooks because polling missed too much';
/** Recorded today, so the sampler must leave it out: it is not a day old yet. */
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

async function push(observation: string, now: Date): Promise<string> {
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
      acceptHookCapture: true,
    },
    { observations: [observation] },
    { identity: WRITE_SESSION, now },
  );
  return result.episode_id;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-recall-probe-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

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
  await push(FRESH_OBSERVATION, PROBED_AT);

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

  it('asks back what it was told and records the hit', async () => {
    const outcome = await recallProbeOperation().run(context());

    expect(outcome.status).toBe('applied');
    // One of the two archived experiences is a day old; the other was pushed today.
    expect(outcome.itemsProcessed).toBe(1);
    expect(outcome.itemsAffected).toBe(1);

    const counters = recallProbeCounters(db);
    expect(counters.samples).toBe(1);
    expect(counters.hits).toBe(1);
    expect(counters.hitRate).toBe(1);
  }, 120_000);

  it('reads how much of what was served came back into the conversation', () => {
    const { served } = recallProbeCounters(db);

    expect(served?.items).toBe(2);
    expect(served?.referenced).toBe(1);
    expect(served?.measuredAt).toBe(PROBED_AT.toISOString());
  });

  it('records the run with the ids it asked about and nothing they said', () => {
    const entry = getLedgerEntry(db, recallProbeLedgerKey('2026-09-05'));
    const summary = entry?.summary as {
      readonly episodes: readonly { readonly id: string; readonly hit: boolean }[];
    };

    expect(summary.episodes).toEqual([{ id: storedEpisodeId, hit: true }]);
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

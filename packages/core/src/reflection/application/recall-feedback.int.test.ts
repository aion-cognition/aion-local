import type { ReflectionInput } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleReflection } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  listUsageEventsAfter,
  type UsageEventKind,
  type UsageEventRow,
} from '../../infrastructure/sqlite/usage-events.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * What a caller says about memories it was served, through the real reflection call: the report
 * lands in the usage stream once, it stays out of the content hash so the same experience with
 * and without it is one episode, and a confirmation reaches the stream only where the substrate
 * held what it named.
 */

const EMBED_DIMENSION = 8;
const SESSION = 'feedback-int-session';
const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const REPORTED_AT = new Date('2026-06-02T10:00:00.000Z');

function vector(): Vector {
  const raw = new Array<number>(EMBED_DIMENSION).fill(0);
  raw[0] = 1;
  return raw;
}

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => vector())),
  generate: () => Promise.reject(new Error('intake spends no generation call')),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let sessions: SessionManager;

async function push(payload: ReflectionInput, now: Date, identity = SESSION): Promise<string> {
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
    payload,
    { identity, now },
  );
  return result.episode_id;
}

function rowsOf(kind: UsageEventKind): readonly UsageEventRow[] {
  return listUsageEventsAfter(db, undefined, 100).filter((event) => event.kind === kind);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-feedback-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'debug' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  sessions = new SessionManager(harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a caller reporting on a pack it was served', () => {
  it('records receipt and use as separate rows against the session that reported them', async () => {
    await push(
      {
        observations: ['the ingest worker drains the queue in batches of fifty'],
        feedback: {
          received: [{ memories: ['node-a', 'node-b'], reporter: 'the calling agent' }],
          used: [{ memories: ['node-a'], reporter: 'the calling agent', evidence: 'turn 12' }],
        },
      },
      STORED_AT,
    );

    expect(rowsOf('delivery_acknowledged')).toHaveLength(1);
    expect(rowsOf('memory_used')[0]?.payload).toMatchObject({
      sessionId: SESSION,
      memories: ['node-a'],
      reporter: 'the calling agent',
      evidence: 'turn 12',
    });
  });

  /**
   * A client retrying a push resends the whole payload. The experience resolves to the episode
   * it already stored, and the report has to resolve the same way or a retry storm reads as a
   * caller insisting.
   */
  it('records one row for a report a retry states again', async () => {
    const payload: ReflectionInput = {
      observations: ['the retry path re-pushes the whole payload'],
      feedback: { used: [{ memories: ['node-c'], reporter: 'the calling agent' }] },
    };
    const first = await push(payload, STORED_AT);
    const second = await push(payload, REPORTED_AT);

    expect(second).toBe(first);
    expect(
      rowsOf('memory_used').filter((event) =>
        (event.payload as { memories: readonly string[] }).memories.includes('node-c'),
      ),
    ).toHaveLength(1);
  });

  /**
   * The same words on a later experience are the caller reporting again, since a report that
   * names no occurrence time has nothing else to identify it by.
   */
  it('reads a wordless report on a second experience as a second report', async () => {
    const reporter = 'the agent reporting twice';
    await push(
      {
        observations: ['the first experience carrying this report'],
        feedback: { used: [{ memories: ['node-e'], reporter }] },
      },
      STORED_AT,
    );
    await push(
      {
        observations: ['the second experience carrying the same report'],
        feedback: { used: [{ memories: ['node-e'], reporter }] },
      },
      REPORTED_AT,
    );

    expect(
      rowsOf('memory_used').filter(
        (event) => (event.payload as { reporter: string }).reporter === reporter,
      ),
    ).toHaveLength(2);
  });

  it('reads the same experience with and without a report as one episode', async () => {
    const observations = ['feedback is a statement about other memories, not about this one'];
    const bare = await push({ observations }, STORED_AT);
    const reported = await push(
      {
        observations,
        feedback: { received: [{ memories: ['node-d'], reporter: 'the calling agent' }] },
      },
      REPORTED_AT,
    );

    expect(reported).toBe(bare);
    expect(rowsOf('delivery_acknowledged')).toHaveLength(2);
  });
});

describe('a confirmation stated about a stored memory', () => {
  it('reaches the stream with the confirmer and the reference, once per statement', async () => {
    const target = await push({ observations: ['the queue drains oldest first'] }, STORED_AT);
    const payload: ReflectionInput = {
      observations: ['confirmed the drain order against the runbook'],
      provenance: {
        confirmations: [{ target, by: 'Ryan Huber', evidence: 'review thread 41' }],
      },
    };

    const episodeId = await push(payload, REPORTED_AT);
    await push(payload, new Date('2026-06-03T10:00:00.000Z'));

    expect(rowsOf('memory_confirmed')).toHaveLength(1);
    expect(rowsOf('memory_confirmed')[0]?.payload).toEqual({
      episodeId,
      memories: [target],
      confirmedBy: 'Ryan Huber',
      evidence: 'review thread 41',
    });
  });

  /** The edge was never written, so there is no signal to record beside it. */
  it('records nothing for a confirmation of something the substrate does not hold', async () => {
    const before = rowsOf('memory_confirmed').length;

    await push(
      {
        observations: ['confirmed something that was never stored'],
        provenance: {
          confirmations: [
            { target: 'no-such-node', by: 'Ryan Huber', evidence: 'review thread 42' },
          ],
        },
      },
      REPORTED_AT,
    );

    expect(rowsOf('memory_confirmed')).toHaveLength(before);
  });
});

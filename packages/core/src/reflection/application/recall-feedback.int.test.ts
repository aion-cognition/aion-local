import type { ReflectionInput } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFIRMATION_SIGNAL_EFFECT } from './confirmation-signals.js';
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
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { recordSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { listEvidenceAcknowledgments } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  listUsageEventsAfter,
  type UsageEventKind,
  type UsageEventRow,
} from '../../infrastructure/sqlite/usage-events.js';
import { SessionManager } from '../../session/session-manager.js';
import { directIntakePublisher } from '../test-support/direct-intake.fixture.js';

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
const RESTATED_AT = new Date('2026-06-04T10:00:00.000Z');
const CONFIRMER = 'Ryan Huber';

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
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
      // The acceptance clock is the push's, so a confirmation that stated no moment carries a
      // time this file can name rather than the moment the run happened.
      publications: directIntakePublisher(harness.driver, db, () => now),
    },
    payload,
    { identity, now },
  );
  return result.episode_id;
}

function rowsOf(kind: UsageEventKind): readonly UsageEventRow[] {
  return listUsageEventsAfter(db, undefined, 200).filter((event) => event.kind === kind);
}

/** The rows this source's confirmations produced, whichever delivery finally wrote them. */
function confirmationsOf(sourceId: string): readonly UsageEventRow[] {
  return rowsOf('memory_confirmed').filter(
    (event) => (event.payload as { episodeId: string }).episodeId === sourceId,
  );
}

/** The confirmation targets this source's accepted batches have brought into the committed view. */
function committedConfirmationTargets(sourceId: string): readonly string[] {
  return listStatedLinks(db, sourceId)
    .filter((link) => link.kind === 'confirms' && link.knownFrom !== null)
    .map((link) => link.toId);
}

/** What the records say the confirmation signal for this source still owes. */
function signalStates(sourceId: string): readonly string[] {
  return listEvidenceAcknowledgments(db, sourceId)
    .filter((entry) => entry.effectKind === CONFIRMATION_SIGNAL_EFFECT)
    .map((entry) => entry.state);
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

  /**
   * A confirmation is a claim about a memory, so the row waits until the substrate can name the
   * memory it is about. The statement is accepted either way.
   */
  it('records nothing for a confirmation of something the substrate does not hold', async () => {
    const before = rowsOf('memory_confirmed').length;

    const sourceId = await push(
      {
        observations: ['confirmed something that was never stored'],
        provenance: {
          confirmations: [{ target: 'no-such-node', by: CONFIRMER, evidence: 'review thread 42' }],
        },
      },
      REPORTED_AT,
    );

    expect(rowsOf('memory_confirmed')).toHaveLength(before);
    // Not dropped: the signal is owed, and a reader counting owed work sees it.
    expect(signalStates(sourceId)).toEqual(['owed']);
  });
});

/**
 * A statement about an identity the substrate has not taken yet. Nothing here is a graph
 * question: the durable records are what answer whether a confirmation names a memory, so a
 * source whose raw projection was never written is a resolved target and an id nothing accounts
 * for is not.
 */
describe('a confirmation whose target the substrate cannot name yet', () => {
  const LATE_TARGET = 'feedback-int-late-target';
  const LATE_SESSION = 'feedback-int-late-session';
  const LATE_EVIDENCE = 'review thread 43';
  const LATE_OBSERVATIONS = ['confirmed a memory this substrate has not taken yet'];
  let lateSourceId = '';

  it('keeps the statement and owes the signal rather than writing a row', async () => {
    lateSourceId = await push(
      {
        observations: LATE_OBSERVATIONS,
        provenance: {
          confirmations: [{ target: LATE_TARGET, by: CONFIRMER, evidence: LATE_EVIDENCE }],
        },
      },
      REPORTED_AT,
      LATE_SESSION,
    );

    expect(confirmationsOf(lateSourceId)).toEqual([]);
    expect(signalStates(lateSourceId)).toEqual(['owed']);
  });

  /**
   * One of the two ways an owed signal is discharged, and the narrower one: this source states
   * something else and the settlement that acknowledgment runs sweeps what it already owed. It
   * proves the sweep is over the source's whole confirmation set rather than the batch being
   * acknowledged. It does not prove passive completion, because the caller had to come back; the
   * repair that finishes an owed signal with no further traffic is its own battery.
   */
  it('settles an earlier owed signal when the same source states something else later', async () => {
    // The occurrence arrives late, which is the ordinary out-of-order case: the caller confirmed
    // a memory it had been served before this substrate accepted it.
    recordSourceRecord(db, {
      sourceId: LATE_TARGET,
      sessionId: LATE_SESSION,
      verificationStatus: 'verified',
      occurredAt: STORED_AT.toISOString(),
      createdAt: STORED_AT,
      archive: {
        canonicalArchiveId: `${LATE_TARGET}-archive`,
        archiveSchemaVersion: 1,
        identityHash: `${LATE_TARGET}-identity`,
        verifiedContentDigest: `${LATE_TARGET}-digest`,
        verificationPolicyVersion: 1,
        archivedAt: STORED_AT.toISOString(),
      },
    });

    // The caller does not restate the confirmation. Any later statement this source makes
    // settles what it already owed.
    await push(
      {
        observations: LATE_OBSERVATIONS,
        provenance: { derived_from: ['feedback-int-unrelated-source'] },
      },
      RESTATED_AT,
      LATE_SESSION,
    );

    const confirmed = confirmationsOf(lateSourceId);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.payload).toEqual({
      episodeId: lateSourceId,
      memories: [LATE_TARGET],
      confirmedBy: CONFIRMER,
      evidence: LATE_EVIDENCE,
    });
    // The statement's own moment, which is the first acceptance and not the settlement that
    // finally wrote the row.
    expect(confirmed[0]?.occurredAt).toBe(REPORTED_AT.toISOString());
    expect(signalStates(lateSourceId)).toEqual(['completed']);
  });

  it('adds nothing when the same confirmation is delivered again', async () => {
    await push(
      {
        observations: LATE_OBSERVATIONS,
        provenance: {
          confirmations: [{ target: LATE_TARGET, by: CONFIRMER, evidence: LATE_EVIDENCE }],
        },
      },
      new Date('2026-06-05T10:00:00.000Z'),
      LATE_SESSION,
    );

    const confirmed = confirmationsOf(lateSourceId);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.occurredAt).toBe(REPORTED_AT.toISOString());
  });

  it('writes one for an identity the records hold and the graph never projected', async () => {
    const archiveOnly = 'feedback-int-archive-only-target';
    const session = 'feedback-int-archive-only-session';
    recordSourceRecord(db, {
      sourceId: archiveOnly,
      sessionId: session,
      verificationStatus: 'verified',
      occurredAt: STORED_AT.toISOString(),
      createdAt: STORED_AT,
      archive: {
        canonicalArchiveId: `${archiveOnly}-archive`,
        archiveSchemaVersion: 1,
        identityHash: `${archiveOnly}-identity`,
        verifiedContentDigest: `${archiveOnly}-digest`,
        verificationPolicyVersion: 1,
        archivedAt: STORED_AT.toISOString(),
      },
    });

    const sourceId = await push(
      {
        observations: ['confirmed a memory whose raw projection is gone'],
        provenance: {
          confirmations: [{ target: archiveOnly, by: CONFIRMER, evidence: 'review thread 44' }],
        },
      },
      REPORTED_AT,
      session,
    );

    expect(confirmationsOf(sourceId)).toHaveLength(1);
    expect(signalStates(sourceId)).toEqual(['completed']);
  });

  /**
   * The append and the acknowledgment stand or fall together. A refusal that was swallowed would
   * leave the settlement recorded over a row nothing wrote, and no later pass looks for it again.
   */
  it('takes the whole acknowledgment with it when the stream refuses the row', async () => {
    const refusedTarget = 'feedback-int-refused-target';
    const session = 'feedback-int-refused-session';
    recordSourceRecord(db, {
      sourceId: refusedTarget,
      sessionId: session,
      verificationStatus: 'verified',
      occurredAt: STORED_AT.toISOString(),
      createdAt: STORED_AT,
      archive: {
        canonicalArchiveId: `${refusedTarget}-archive`,
        archiveSchemaVersion: 1,
        identityHash: `${refusedTarget}-identity`,
        verifiedContentDigest: `${refusedTarget}-digest`,
        verificationPolicyVersion: 1,
        archivedAt: STORED_AT.toISOString(),
      },
    });
    const observations = ['confirmed a memory the stream will not take'];
    // Stated bare first, so the confirmation below lands on a source this test can name.
    const sourceId = await push({ observations }, REPORTED_AT, session);
    const payload: ReflectionInput = {
      observations,
      provenance: {
        confirmations: [{ target: refusedTarget, by: CONFIRMER, evidence: 'review thread 45' }],
      },
    };

    db.exec(
      `CREATE TRIGGER refuse_confirmed BEFORE INSERT ON usage_events
       WHEN NEW.kind = 'memory_confirmed'
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    try {
      await expect(push(payload, REPORTED_AT, session)).rejects.toThrow(/refused/);
    } finally {
      db.exec('DROP TRIGGER refuse_confirmed');
    }

    expect(confirmationsOf(sourceId)).toEqual([]);
    // The whole acknowledgment went with the refusal, so nothing says the signal was delivered
    // and nothing says the batch carrying it settled.
    expect(signalStates(sourceId)).toEqual([]);
    expect(committedConfirmationTargets(sourceId)).toEqual([]);
  });
});

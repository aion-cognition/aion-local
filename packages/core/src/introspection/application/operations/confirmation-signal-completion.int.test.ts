import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  confirmationSignalCompletionOperation,
  CONFIRMATION_SIGNAL_COMPLETION_OPERATION,
} from './confirmation-signal-completion.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../../infrastructure/publication/types.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../../infrastructure/sqlite/evidence-links.js';
import { listEvidenceAcknowledgments } from '../../../infrastructure/sqlite/source-lifecycle.js';
import {
  listUsageEventsAfter,
  type UsageEventRow,
} from '../../../infrastructure/sqlite/usage-events.js';
import { CONFIRMATION_SIGNAL_EFFECT } from '../../../reflection/application/confirmation-signals.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../../../reflection/application/installed-publications.js';
import {
  handleReflection,
  type ReflectionIntakeDeps,
} from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { publishPipelineReadinessPolicy } from '../../../reflection/application/readiness.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * A confirmation of a memory the substrate had not taken, finished by the repair that owns it.
 *
 * Everything here runs through a real coordinator against real stores, because the point is the
 * wiring: the acceptance is long acknowledged, so the recovery loop has nothing to recover, and
 * its acknowledgment may not ask the graph. The target arrives with no further traffic on the
 * source that confirmed it, the repair is interrupted once and refused once, and the event lands
 * exactly one time carrying the moment the confirmation was first accepted.
 *
 * No provider is constructed in this file's import graph and nothing generates or embeds.
 */

const ACCEPTED_AT = new Date('2026-09-08T06:00:00.000Z');
const ARRIVED_AT = new Date('2026-09-09T06:00:00.000Z');
const REPAIRED_AT = new Date('2026-09-10T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities'];

/** A retained interpretation with no durable source record: the case only the graph can answer. */
const LATE_TARGET = 'confirmation-repair-late-target';
const CONFIRMER = 'Ryan Huber';
const EVIDENCE = 'review thread 61';
const SESSION = 'confirmation-repair-session';

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let logger: Logger;
let coordinator: PublicationCoordinator;
let intake: ReflectionIntakeDeps;
let clock = ACCEPTED_AT;
let failAt: PublicationBoundary | undefined;
let sourceId = '';

function newCoordinator(): PublicationCoordinator {
  return new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => clock,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error(`interrupted at ${boundary}`);
      }
    },
  });
}

function context(publisher: PublicationCoordinator): OperationContext {
  return {
    driver: substrate.harness.driver,
    db: store.db,
    config: DEFAULTS,
    logger,
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('no generation in this battery')),
    },
    references: publisher,
    health: healthFixture(),
    now: REPAIRED_AT,
    signal: new AbortController().signal,
  };
}

function confirmations(): readonly UsageEventRow[] {
  return listUsageEventsAfter(store.db, undefined, 100).filter(
    (event) => event.kind === 'memory_confirmed',
  );
}

function signalState(): string | undefined {
  return listEvidenceAcknowledgments(store.db, sourceId).find(
    (row) => row.effectKind === CONFIRMATION_SIGNAL_EFFECT,
  )?.state;
}

/** The moment the FIRST accepted version recorded, which is what the event has to carry. */
function firstAcceptedMoment(): string {
  const link = listStatedLinks(store.db, sourceId).find((row) => row.kind === 'confirms');
  const values = store.db
    .prepare(
      'SELECT recorded_values_json AS json FROM evidence_link_versions WHERE link_id = ? ORDER BY version LIMIT 1',
    )
    .get(link?.linkId) as { json: string };
  return (JSON.parse(values.json) as { occurredAt: string }).occurredAt;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-confirmation-repair-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'fatal' });
  coordinator = newCoordinator();
  await coordinator.initialize();
  publishPipelineReadinessPolicy(
    store.db,
    STAGES.map((name) => ({ name, run: () => Promise.resolve({ status: 'ok', summary: '' }) })),
    ACCEPTED_AT,
  );
  intake = {
    driver: substrate.harness.driver,
    db: store.db,
    sessions: new SessionManager(substrate.harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: {
      embed: () => Promise.reject(new Error('no embedding in this battery')),
      generate: () => Promise.reject(new Error('no generation in this battery')),
    },
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };
}, 300_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('accepts a confirmation of an identity nothing holds and owes its signal', async () => {
  const accepted = await handleReflection(
    intake,
    {
      observations: ['confirmed a memory this substrate has not taken'],
      provenance: { confirmations: [{ target: LATE_TARGET, by: CONFIRMER, evidence: EVIDENCE }] },
    },
    { identity: SESSION, now: ACCEPTED_AT },
  );
  sourceId = accepted.episode_id;

  expect(confirmations()).toEqual([]);
  expect(signalState()).toBe('owed');
  // The statement itself is durable against the identity the caller named.
  expect(
    listStatedLinks(store.db, sourceId)
      .filter((row) => row.kind === 'confirms' && row.knownFrom !== null)
      .map((row) => row.toId),
  ).toEqual([LATE_TARGET]);
});

it('leaves the signal owed when the repair is interrupted before its acknowledgment', async () => {
  // The target arrives as a retained node and nothing else happens on the source that confirmed
  // it: no restatement, no second delivery, no worker pass. Only the graph knows it is here, so
  // the SQLite-only acknowledgment cannot see it and the repair's guarded prepare must.
  await writeStampedNode(substrate.harness.driver, {
    label: 'Insight',
    id: LATE_TARGET,
    now: ARRIVED_AT,
    occurredAt: ARRIVED_AT,
    properties: { text: 'the memory the confirmation was about' },
  });
  clock = REPAIRED_AT;

  failAt = 'before_ack';
  const outcome = await confirmationSignalCompletionOperation().run(context(coordinator));

  expect(outcome.status).toBe('noop');
  expect(confirmations()).toEqual([]);
  expect(signalState()).toBe('owed');
});

it('leaves it owed again when the stream refuses the row after a restart', async () => {
  // A fresh coordinator is the restart: it recovers whatever the interrupted attempt left before
  // it publishes anything of its own.
  const restarted = newCoordinator();
  await restarted.initialize();
  store.db.exec(
    `CREATE TRIGGER refuse_confirmed BEFORE INSERT ON usage_events
     WHEN NEW.kind = 'memory_confirmed'
     BEGIN SELECT RAISE(ABORT, 'refused'); END`,
  );
  try {
    const outcome = await confirmationSignalCompletionOperation().run(context(restarted));

    expect(outcome.status).toBe('noop');
  } finally {
    store.db.exec('DROP TRIGGER refuse_confirmed');
  }

  expect(confirmations()).toEqual([]);
  expect(signalState()).toBe('owed');
});

it('settles it once the stream takes the row, under the moment it was first accepted', async () => {
  const settling = newCoordinator();
  await settling.initialize();

  const outcome = await confirmationSignalCompletionOperation().run(context(settling));

  expect(outcome.status).toBe('applied');
  expect(outcome.itemsAffected).toBe(1);
  const written = confirmations();
  expect(written).toHaveLength(1);
  expect(written[0]?.payload).toEqual({
    episodeId: sourceId,
    memories: [LATE_TARGET],
    confirmedBy: CONFIRMER,
    evidence: EVIDENCE,
  });
  // The first acceptance's clock, not the repair's.
  expect(written[0]?.occurredAt).toBe(firstAcceptedMoment());
  expect(written[0]?.occurredAt).not.toBe(REPAIRED_AT.toISOString());
  expect(signalState()).toBe('completed');
});

it('adds nothing on a later run and leaves the operation with nothing owed', async () => {
  const again = newCoordinator();
  await again.initialize();

  const outcome = await confirmationSignalCompletionOperation().run(context(again));

  expect(outcome).toEqual({
    status: 'noop',
    itemsProcessed: 0,
    itemsAffected: 0,
    detail: 'no confirmation signal is owed',
  });
  expect(confirmations()).toHaveLength(1);
  expect(signalState()).toBe('completed');
});

it('declines rather than settling outside the guard when no publisher is composed', async () => {
  const bare = { ...context(coordinator) };
  delete (bare as { references?: unknown }).references;

  const outcome = await confirmationSignalCompletionOperation().run(bare);

  expect(outcome.status).toBe('noop');
  expect(outcome.detail).toContain('no publisher composed');
  expect(confirmationSignalCompletionOperation().name).toBe(
    CONFIRMATION_SIGNAL_COMPLETION_OPERATION,
  );
});

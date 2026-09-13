import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { confirmationSignalCompletionOperation } from './confirmation-signal-completion.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { fetchClaimProvenance } from '../../../infrastructure/graph/claim-provenance-queries.js';
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
const REPAIRED_AT = new Date('2026-09-10T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const STAGES = ['entities'];

/** A retained interpretation with no durable source record: the case only the graph can answer. */
const CONFIRMER = 'Ryan Huber';
const EVIDENCE = 'review thread 61';

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
    now: clock,
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
    publications: coordinator,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
  };
}, 300_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

async function acceptTargets(identity: string, targets: readonly string[]): Promise<string> {
  const accepted = await handleReflection(
    intake,
    {
      observations: [identity],
      provenance: {
        confirmations: targets.map((target) => ({ target, by: CONFIRMER, evidence: EVIDENCE })),
      },
    },
    { identity, now: clock },
  );
  return accepted.episode_id;
}

async function createTarget(id: string): Promise<void> {
  await writeStampedNode(substrate.harness.driver, {
    label: 'Insight',
    id,
    now: clock,
    occurredAt: clock,
    properties: { text: id },
  });
}

function eventsFor(id: string): readonly UsageEventRow[] {
  return confirmations().filter(
    (event) => (event.payload as { episodeId?: string }).episodeId === id,
  );
}

it('does not report an unresolved acknowledgment as a completed signal, then resolves on a later pass', async () => {
  clock = ACCEPTED_AT;
  sourceId = await acceptTargets('single-unresolved', ['single-late']);
  clock = REPAIRED_AT;
  const waiting = await confirmationSignalCompletionOperation().run(context(coordinator));
  expect(signalState()).toBe('owed');
  expect(eventsFor(sourceId)).toHaveLength(0);
  expect.soft(waiting.itemsAffected).toBe(0);
  clock = new Date(REPAIRED_AT.getTime() + 1000);
  await createTarget('single-late');
  await confirmationSignalCompletionOperation().run(context(coordinator));
  expect(eventsFor(sourceId)).toHaveLength(1);
  expect(signalState()).toBe('completed');
  const provenance = await fetchClaimProvenance(substrate.harness.driver, {
    ids: ['single-late'],
    maxRoots: 4,
    mode: { reference: clock },
  });
  expect(provenance.get('single-late')?.confirmation?.at.toISOString()).toBe(
    eventsFor(sourceId)[0]?.occurredAt,
  );
});

it('finishes one shared obligation when its targets resolve on different repair passes', async () => {
  clock = new Date(ACCEPTED_AT.getTime() + 2000);
  sourceId = await acceptTargets('staggered-unresolved', ['staggered-a', 'staggered-b']);
  clock = new Date(REPAIRED_AT.getTime() + 2000);
  await confirmationSignalCompletionOperation().run(context(coordinator));
  expect(signalState()).toBe('owed');
  clock = new Date(REPAIRED_AT.getTime() + 3000);
  await createTarget('staggered-a');
  await confirmationSignalCompletionOperation().run(context(coordinator));
  expect(eventsFor(sourceId)).toHaveLength(1);
  expect(signalState()).toBe('owed');
  clock = new Date(REPAIRED_AT.getTime() + 4000);
  await createTarget('staggered-b');
  const warnings = vi.spyOn(logger, 'warn');
  const outcome = await confirmationSignalCompletionOperation().run(context(coordinator));
  console.log(
    JSON.stringify({
      event: 'staggered_repair_warnings',
      messages: warnings.mock.calls.map(([fields]) => {
        const error = (fields as { err?: unknown }).err;
        const messages: string[] = [];
        let current = error;
        while (current instanceof Error) {
          messages.push(current.message);
          current = current.cause;
        }
        return messages;
      }),
    }),
  );
  warnings.mockRestore();
  expect.soft(eventsFor(sourceId)).toHaveLength(2);
  expect.soft(signalState()).toBe('completed');
  expect(outcome.itemsAffected).toBe(1);
});

import { Neo4jError } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './consolidation-rehearsal.fixture.js';
import { episodeIdsInSession } from './graph-queries.fixture.js';
import { intakePublication } from '../../../reflection/application/intake-publication.js';
import { prepareEpisode, type ReflectionContent } from '../../../reflection/domain/content.js';
import { PIPELINE_VERSION } from '../../../reflection/domain/version.js';
import { SessionManager } from '../../../session/session-manager.js';
import { PublicationCoordinator } from '../../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../publication/handlers.js';
import type { PublicationHandler, PublicationOutcome } from '../../publication/types.js';
import { SqliteStore } from '../../sqlite/database.js';
import { ARCHIVE_SCHEMA_VERSION, experienceArchiveKey } from '../../sqlite/experience-archive.js';
import {
  coordinatorControl,
  publicationRecord,
} from '../../sqlite/publication-coordinator-store.js';
import { bootstrapBackbone } from '../backbone.js';
import { runGraphMigrations } from '../migrations.js';

/**
 * One throwaway substrate driving the shipped client flow: `SessionManager.ensureSession`,
 * then `PublicationCoordinator.publish({kind:'intake'})` through `intakePublication`. The
 * files that share it assert on lock order, on concurrency, and on what survives a store
 * failure, and all three need the same boot.
 *
 * No provider is constructed and no generation is requested. The payload is a fixed script,
 * so a run here reaches Neo4j over bolt and SQLite in process and nothing else.
 */

const EMBED_DIMENSION = 3;

/** A publication failure is the subject of these files, not noise to report. */
const SILENT = { warn: () => undefined, error: () => undefined };

export type IntakeProbe = {
  readonly substrate: RehearsalSubstrate;
  readonly store: SqliteStore;
  readonly coordinator: PublicationCoordinator;
  readonly sessions: SessionManager;
  readonly memberId: string;
  readonly workspaceId: string;
  readonly dir: string;
};

export type IntakeProbeRequest = {
  /** Prefix for this file's own temporary directory, so a leftover names its owner. */
  readonly prefix: string;
  /** Replaces `intakePublication` in the registration; used to inject a store failure. */
  readonly handler?: PublicationHandler;
};

export async function startIntakeProbe(request: IntakeProbeRequest): Promise<IntakeProbe> {
  const dir = mkdtempSync(join(tmpdir(), request.prefix));
  const substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  const store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, {
    embedDimension: EMBED_DIMENSION,
  });
  const backbone = await bootstrapBackbone(substrate.harness.driver, { memberName: 'member' });
  const sessions = new SessionManager(substrate.harness.driver, {
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
  });
  const coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger: SILENT,
    handlers: [...PUBLICATION_HANDLERS, request.handler ?? intakePublication],
  });
  await coordinator.initialize();
  return {
    substrate,
    store,
    coordinator,
    sessions,
    memberId: backbone.member.id,
    workspaceId: backbone.workspace.id,
    dir,
  };
}

export async function stopIntakeProbe(probe: IntakeProbe | undefined): Promise<void> {
  probe?.store.close();
  await stopRehearsalSubstrate(probe?.substrate);
  if (probe !== undefined) {
    rmSync(probe.dir, { recursive: true, force: true });
  }
}

export function reflectionContent(marker: string): ReflectionContent {
  return {
    turns: [
      { role: 'user', text: `why did the ingestion service pick webhooks ${marker}` },
      { role: 'assistant', text: `polling was too slow ${marker}` },
    ],
    observations: [`picked webhooks for ingestion ${marker}`],
  };
}

export function intakePayload(
  identity: string,
  marker: string,
  occurredAt: Date,
): Record<string, unknown> {
  return {
    identity,
    sessionId: identity,
    payloadJson: JSON.stringify(reflectionContent(marker)),
    referencesJson: null,
    lane: null,
    originJson: JSON.stringify({ channel: 'mcp' }),
    pipelineVersion: PIPELINE_VERSION,
    occurredAt: occurredAt.toISOString(),
    indexPolicy: 'archive-v1',
    readiness: { policyRevision: 1, stageNames: ['entities', 'cognitive'] },
  };
}

export async function publishIntake(
  probe: IntakeProbe,
  input: {
    readonly identity: string;
    readonly marker: string;
    readonly operationId: string;
    readonly occurredAt: Date;
  },
): Promise<PublicationOutcome> {
  return probe.coordinator.publish({
    kind: 'intake',
    operationId: input.operationId,
    payload: intakePayload(input.identity, input.marker, input.occurredAt),
  });
}

/** The whole client flow one connection runs: connect, then store. */
export async function runClientFlow(
  probe: IntakeProbe,
  input: { readonly identity: string; readonly marker: string; readonly occurredAt: Date },
): Promise<PublicationOutcome> {
  await probe.sessions.ensureSession({
    identity: input.identity,
    now: input.occurredAt,
    occurredAt: input.occurredAt,
  });
  return publishIntake(probe, { ...input, operationId: `intake:${input.identity}` });
}

export function archiveKeyFor(identity: string, marker: string): string {
  const prepared = prepareEpisode(reflectionContent(marker), new Date());
  return experienceArchiveKey(identity, prepared.contentHash, ARCHIVE_SCHEMA_VERSION);
}

export function archivedRows(store: SqliteStore, identity: string): number {
  const row = store.db
    .prepare('SELECT count(*) AS n FROM experience_archive WHERE session_id = ?')
    .get(identity) as { n: number };
  return row.n;
}

export type PublicationSnapshot = {
  readonly state: string | undefined;
  readonly pending: string | null;
  readonly archived: number;
  readonly graphEpisodes: readonly string[];
};

/** What the substrate durably holds for one operation, read without acquiring the guard. */
export async function snapshotOf(
  probe: IntakeProbe,
  identity: string,
  operationId: string,
): Promise<PublicationSnapshot> {
  const record = publicationRecord(probe.store.db, operationId);
  return {
    state: record?.state,
    pending: coordinatorControl(probe.store.db).pendingOperationId,
    archived: archivedRows(probe.store, identity),
    graphEpisodes: await episodeIdsInSession(probe.substrate.harness.driver, identity),
  };
}

/** The whole diagnostic chain, so a native code is never swallowed by the wrapper above it. */
export function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor instanceof Error; depth += 1) {
    const { code } = cursor as { code?: unknown };
    parts.push(`${cursor.name}${typeof code === 'string' ? `[${code}]` : ''}: ${cursor.message}`);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join('\n  caused by ');
}

export function mentionsDeadlock(err: unknown): boolean {
  return /deadlock/i.test(errorChain(err));
}

export const DEADLOCK_CODE = 'Neo.TransientError.Transaction.DeadlockDetected';

export type ArmedIntake = {
  /** Register this in place of `intakePublication`. */
  readonly handler: PublicationHandler;
  /** Owes exactly one failure; the next intake projection consumes it. */
  arm(): void;
  disarm(): void;
};

/**
 * `intakePublication` with one store failure armed behind it.
 *
 * The projection runs first and the failure lands after it, inside the same graph transaction
 * and before the commit, which is where a Forseti victim died before the lock order was
 * corrected. The error carries the store's own deadlock code, so it takes the same
 * classification route: `publicationFailure` reads it through the driver's `isRetryableError`
 * and the caller is handed a retryable publication error.
 *
 * It is injected rather than provoked because the fix removed the inversion that produced it.
 * What this proves is what survives such a failure, not that one still happens.
 */
export function intakeFailingAfterProjection(): ArmedIntake {
  const base = intakePublication;
  let owed = false;
  const handler: PublicationHandler = {
    kind: base.kind,
    effectKinds: base.effectKinds,
    decodePayload: (value) => base.decodePayload(value),
    decodeData: (value) => base.decodeData(value),
    decodeResult: (value) => base.decodeResult(value),
    prepare: (context, payload) => base.prepare(context, payload),
    check: (context, plan) => base.check(context, plan),
    applyGraph: async (context, plan) => {
      const result = await base.applyGraph(context, plan);
      if (owed) {
        owed = false;
        throw new Neo4jError(
          'the store could not serialize this write',
          DEADLOCK_CODE,
          '',
          'the transaction was chosen to break a lock wait cycle',
        );
      }
      return result;
    },
    prepareSqlite: (context, plan) => base.prepareSqlite(context, plan),
    acknowledgeSqlite: (context, plan, result) => base.acknowledgeSqlite(context, plan, result),
    discardSqlite: (context, plan, reason) => base.discardSqlite(context, plan, reason),
  };
  return {
    handler,
    arm: () => {
      owed = true;
    },
    disarm: () => {
      owed = false;
    },
  };
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { projectEpisodeInTransaction } from './experience-store.js';
import { activateSourceManifest, writeSourceManifest } from './source-manifest.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type {
  JsonValue,
  PublicationContext,
  PublicationPlan,
  PublicationSqliteContext,
} from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  experienceArchiveKey,
} from '../../infrastructure/sqlite/experience-archive.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { readGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import {
  enqueueReflectionJob,
  findPendingJobForEpisode,
  REFLECTION_QUEUE_EPISODE_FIELD,
} from '../../infrastructure/sqlite/reflection-queue.js';
import { captureOrderValue } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  occurrenceCandidates,
  resolveSourceOccurrence,
  type OccurrenceKey,
  type OccurrenceResolution,
} from '../../infrastructure/sqlite/source-occurrence.js';
import { hashContent, prepareEpisode, type ReflectionContent } from '../domain/content.js';

/**
 * Intake as a publication: the guarded decision about which source an accepted payload is,
 * the one durable prepare that mints its records, the graph projection, and the acknowledgment
 * that makes the work claimable.
 *
 * The order is what the crash cases turn on. The occurrence is selected under the guard, so a
 * forget landing between a caller's first look and this decision changes the answer rather than
 * being missed. Everything durable is written before the graph is touched, so a crash between
 * the two resumes the ids that were already minted. The queue enqueue is an acknowledgment
 * effect, so no worker can claim a job for an episode that does not exist.
 */
export const INTAKE_JOB_TYPE = 'integrate';

/**
 * The bounded source-index work an acceptance owes. C6 owns the handler, the digest
 * idempotence and the part cursor; the enqueue here is the acceptance effect and nothing more.
 * The row carries the original logical source id, and it never enters the extraction pipeline.
 */
export const SOURCE_INDEX_JOB_TYPE = 'source_index';

export const INTAKE_EFFECTS = {
  projection: 'graph_projection',
  enqueue: 'reflection_queue_enqueue',
  watermark: 'session_watermark',
  index: 'search_index_enqueue',
} as const;

const Readiness = z.strictObject({
  policyRevision: z.number().int().nonnegative(),
  stageNames: z.array(z.string().min(1)),
});

const Payload = z.strictObject({
  identity: z.string().min(1),
  sessionId: z.string().min(1),
  /** The redacted content as the archive holds it. A string so the codec stays strict. */
  payloadJson: z.string().min(1),
  referencesJson: z.string().nullable(),
  lane: z.string().nullable(),
  originJson: z.string().nullable(),
  pipelineVersion: z.string().min(1),
  occurredAt: z.string().min(1),
  indexPolicy: z.string().min(1),
  readiness: Readiness.nullable(),
});

const Data = Payload.extend({
  decision: z.enum(['new', 'reuse', 'pinned']),
  /** Why a pinned decision refuses, so the intent says which rule stopped it. */
  pinnedReason: z.enum(['occurrence_ambiguous', 'occurrence_state_uncertain']).nullable(),
  sourceId: z.string(),
  turnIds: z.array(z.string().min(1)),
  contentHash: z.string().min(1),
  identityHash: z.string().min(1),
  /** Which occurrences the guarded read saw, so the check can tell that the answer moved. */
  candidateDigest: z.string().min(1),
  residency: z.enum(['resident', 'retiring', 'evicted', 'absent']),
  pinnedCandidates: z.array(z.string().min(1)),
});

const Result = z.strictObject({
  sourceId: z.string(),
  created: z.boolean(),
  turnIds: z.array(z.string().min(1)),
});

export type IntakePayload = z.infer<typeof Payload>;
type IntakeData = z.infer<typeof Data>;

function content(data: IntakePayload): ReflectionContent {
  return JSON.parse(data.payloadJson) as ReflectionContent;
}

function references(data: IntakePayload): ReflectionContent['provenance'] {
  return data.referencesJson === null
    ? undefined
    : (JSON.parse(data.referencesJson) as ReflectionContent['provenance']);
}

function origin(data: IntakePayload): { channel: 'hook' | 'mcp' | 'cli' | 'system' } | undefined {
  return data.originJson === null
    ? undefined
    : (JSON.parse(data.originJson) as { channel: 'hook' | 'mcp' | 'cli' | 'system' });
}

/** The archive's own key, which is what an occurrence is looked up by. */
function occurrenceKey(payload: IntakePayload): OccurrenceKey & { contentHash: string } {
  const prepared = prepareEpisode(content(payload), new Date(payload.occurredAt));
  const identityHash = experienceArchiveKey(
    payload.identity,
    prepared.contentHash,
    ARCHIVE_SCHEMA_VERSION,
  );
  return { identityHash, sessionId: payload.sessionId, contentHash: prepared.contentHash };
}

/**
 * What the guarded read saw of the OTHER occurrences under this key, so a decision taken
 * against a moved answer is refused.
 *
 * The operation's own source is excluded on purpose. Its durable prepare writes that source
 * record, so a recovery re-reading this after the crash would otherwise see a set that grew by
 * exactly the row it wrote itself and defer forever.
 */
function candidateDigest(db: SqliteHandle, key: OccurrenceKey, ownSourceId: string): string {
  return hashContent(occurrenceCandidates(db, key).filter((sourceId) => sourceId !== ownSourceId));
}

function indexWorkKey(sourceId: string, indexPolicy: string): string {
  return `${SOURCE_INDEX_JOB_TYPE}:${sourceId}:${indexPolicy}`;
}

/**
 * What acceptance owes once the graph commits. A decision that mints nothing owes nothing: an
 * evicted or resident duplicate is already projected, already queued and already indexed.
 */
function acceptanceEffects(data: IntakeData): PublicationPlan<IntakeData>['effects'] {
  if (data.decision !== 'new') {
    return [];
  }
  const detail = (value: JsonValue): JsonValue => value;
  return [
    { kind: INTAKE_EFFECTS.projection, detail: detail({ sourceId: data.sourceId }) },
    { kind: INTAKE_EFFECTS.enqueue, detail: detail({ sourceId: data.sourceId }) },
    { kind: INTAKE_EFFECTS.watermark, detail: detail({ sessionId: data.sessionId }) },
    {
      kind: INTAKE_EFFECTS.index,
      detail: detail({ sourceId: data.sourceId, indexPolicy: data.indexPolicy }),
    },
  ];
}

type OccurrenceBase = IntakePayload & {
  readonly contentHash: string;
  readonly identityHash: string;
};

/**
 * The authoritative selection, as a plan. A held occurrence answers with its original id
 * whatever its storage, a forgotten one mints a replacement, and an ambiguous key mints nothing
 * at all: two live occurrences of one payload is a question the records cannot answer, and
 * picking one would record a decision nobody made. An occurrence with a statement still in
 * flight is the same refusal for the same reason: the answer is about to move.
 */
function decide(
  base: OccurrenceBase,
  resolution: OccurrenceResolution,
  turnCount: number,
): Omit<IntakeData, 'candidateDigest'> {
  if (resolution.kind === 'ambiguous' || resolution.kind === 'uncertain') {
    return {
      ...base,
      decision: 'pinned',
      pinnedReason:
        resolution.kind === 'ambiguous' ? 'occurrence_ambiguous' : 'occurrence_state_uncertain',
      sourceId: '',
      turnIds: [],
      residency: 'absent',
      pinnedCandidates: [...resolution.sourceIds],
    };
  }
  if (resolution.kind === 'held') {
    return {
      ...base,
      decision: 'reuse',
      pinnedReason: null,
      sourceId: resolution.sourceId,
      turnIds: [],
      residency: resolution.residency,
      pinnedCandidates: [],
    };
  }
  return {
    ...base,
    decision: 'new',
    pinnedReason: null,
    sourceId: randomUUID(),
    turnIds: Array.from({ length: turnCount }, () => randomUUID()),
    residency: 'absent',
    pinnedCandidates: [],
  };
}

/**
 * The intake operation, registered on the coordinator. Its prepare runs under the guard, its
 * durable writes run in the coordinator's short SQLite transaction, and its acknowledgment
 * completes the effects the plan declared.
 */
export const intakePublication = new PublicationOperation({
  kind: 'intake',
  effectKinds: [
    INTAKE_EFFECTS.projection,
    INTAKE_EFFECTS.enqueue,
    INTAKE_EFFECTS.watermark,
    INTAKE_EFFECTS.index,
  ],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('intake cannot publish before the coverage registry exists');
    }
    const key = occurrenceKey(payload);
    const resolution = resolveSourceOccurrence(context.db, key);
    const prepared = prepareEpisode(content(payload), new Date(payload.occurredAt));
    const selected = decide(
      { ...payload, contentHash: key.contentHash, identityHash: key.identityHash },
      resolution,
      prepared.turns.length,
    );
    const data: IntakeData = {
      ...selected,
      candidateDigest: candidateDigest(context.db, key, selected.sourceId),
    };
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([
          {
            kind: 'source',
            id: data.identityHash,
            scope: 'sqlite:source_occurrence',
            version: data.candidateDigest,
          },
        ]),
        sources:
          data.decision === 'reuse'
            ? [
                {
                  sourceId: data.sourceId,
                  generation: String(
                    readGeneration(context.db, data.sourceId, 1)?.processingGeneration ?? 0,
                  ),
                  acceptedReferenceVersion: '1',
                },
              ]
            : [],
        heads: [],
      },
      scopes: [{ kind: 'source', id: data.identityHash, scope: 'sqlite:source_occurrence' }],
      effects: acceptanceEffects(data),
    });
  },
  check(context, data) {
    if (data.decision === 'pinned') {
      return Promise.resolve({
        status: 'rejected',
        reason: data.pinnedReason ?? 'occurrence_ambiguous',
      } as const);
    }
    const key = { identityHash: data.identityHash, sessionId: data.sessionId };
    if (candidateDigest(context.db, key, data.sourceId) !== data.candidateDigest) {
      return Promise.resolve({ status: 'deferred', reason: 'occurrence_changed' } as const);
    }
    // A recovery re-reads its own prepared source as the held occurrence, which is the answer
    // it wrote. Any OTHER occurrence taking the key means the selection is no longer the one
    // this plan was made under.
    const resolution = resolveSourceOccurrence(context.db, key);
    const selects = resolution.kind === 'held' ? resolution.sourceId : '';
    if (selects !== '' && selects !== data.sourceId) {
      return Promise.resolve({ status: 'deferred', reason: 'occurrence_changed' } as const);
    }
    if (data.decision === 'reuse' && selects !== data.sourceId) {
      return Promise.resolve({ status: 'deferred', reason: 'occurrence_changed' } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context: PublicationContext, data: IntakeData) {
    if (data.decision !== 'new') {
      // An evicted duplicate answers with the original id: nothing here rebuilds a projection
      // to satisfy a lookup, which is the rehydration the residency rules forbid.
      return { sourceId: data.sourceId, created: false, turnIds: [] };
    }
    const stored = await projectEpisodeInTransaction(context.graph, {
      prepared: prepareEpisode(content(data), new Date(data.occurredAt)),
      sessionId: data.sessionId,
      origin: origin(data),
      now: context.now,
      identity: { episodeId: data.sourceId, turnIds: data.turnIds },
    });
    return { sourceId: stored.episodeId, created: true, turnIds: [...data.turnIds] };
  },
  prepareSqlite(context: PublicationSqliteContext, data: IntakeData) {
    if (data.decision !== 'new') {
      return undefined;
    }
    writeSourceManifest(
      context.db,
      {
        sourceId: data.sourceId,
        sessionId: data.sessionId,
        identity: data.identity,
        prepared: prepareEpisode(content(data), new Date(data.occurredAt)),
        payload: content(data),
        references: references(data),
        lane: data.lane ?? undefined,
        origin: origin(data),
        pipelineVersion: data.pipelineVersion,
        operationKey: context.operationId,
        readiness: data.readiness ?? undefined,
        now: new Date(data.occurredAt),
      },
      data.turnIds,
    );
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.decision !== 'new') {
      return undefined;
    }
    const generation = readGeneration(context.db, data.sourceId, 1);
    if (generation === undefined) {
      throw new Error(`intake ${context.operationId} acknowledged with no prepared generation`);
    }
    const position = context.db
      .prepare('SELECT id FROM ingest_log WHERE source_id = ?')
      .get(data.sourceId) as { id: number } | undefined;
    activateSourceManifest(context.db, {
      sourceId: data.sourceId,
      processingGeneration: generation.processingGeneration,
      sessionId: data.sessionId,
      captureOrderValue: captureOrderValue(position?.id ?? 0),
      now: new Date(data.occurredAt),
    });
    enqueueSourceWork(context.db, data, context.operationId);
    return undefined;
  },
  discardSqlite(context, data, reason) {
    // The accepted input stays: a rejected attempt never clears what the caller stated, and a
    // pinned occurrence is recorded so the ambiguity is inspectable rather than retried blindly.
    markLedgerApplied(context.db, `intake-refused:${context.operationId}`, {
      reason,
      identityHash: data.identityHash,
      decision: data.decision,
      candidates: data.pinnedCandidates,
    });
    return undefined;
  },
});

/**
 * The two queue rows an acceptance owes, both written in the acknowledgment transaction.
 *
 * The integrate job is what the reflection worker runs. The source-index job is C6's and is
 * enqueued in the bulk lane, so it never counts against the depth an interactive caller is told
 * about. Both are looked up before they are written, so a recovery that reaches this step twice
 * finds the row it already wrote.
 */
function enqueueSourceWork(db: SqliteHandle, data: IntakeData, operationId: string): void {
  if (findPendingJobForEpisode(db, INTAKE_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      INTAKE_JOB_TYPE,
      { [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId },
      {
        lane: data.lane === 'bulk' ? 'bulk' : 'interactive',
        sessionId: data.sessionId,
        episodeId: data.sourceId,
        now: new Date(data.occurredAt),
      },
    );
  }
  if (findPendingJobForEpisode(db, SOURCE_INDEX_JOB_TYPE, data.sourceId) === undefined) {
    enqueueReflectionJob(
      db,
      SOURCE_INDEX_JOB_TYPE,
      {
        [REFLECTION_QUEUE_EPISODE_FIELD]: data.sourceId,
        index_policy: data.indexPolicy,
        work_key: indexWorkKey(data.sourceId, data.indexPolicy),
        operation_id: operationId,
      },
      {
        lane: 'bulk',
        sessionId: data.sessionId,
        episodeId: data.sourceId,
        now: new Date(data.occurredAt),
      },
    );
  }
}

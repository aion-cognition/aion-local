import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { projectEpisodeInTransaction } from './experience-store.js';
import { enqueueSourceWork } from './intake-queue.js';
import {
  acceptedTargetsHash,
  acknowledgeReferenceAcceptance,
  classifyStatedReferences,
  discardReferenceAcceptance,
  prepareReferenceAcceptance,
  projectAcceptedReferences,
  statedReferenceIds,
  type ReferenceAcceptance,
  type StatedReferenceInput,
} from './reference-acceptance.js';
import { activateSourceManifest, writeSourceManifest } from './source-manifest.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
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
import { readIngestPosition } from '../../infrastructure/sqlite/migration-cohorts.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { readGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import { readReferenceDelivery } from '../../infrastructure/sqlite/source-identity.js';
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
export const INTAKE_EFFECTS = {
  projection: 'graph_projection',
  enqueue: 'reflection_queue_enqueue',
  watermark: 'session_watermark',
  index: 'search_index_enqueue',
  references: 'reference_batch',
  links: 'evidence_link_versions',
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

const ReferenceTarget = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['corrects', 'derived_from', 'confirms']),
  targetClass: z.enum(['source', 'part', 'retained_node', 'unresolved']),
  confirmation: z
    .strictObject({
      by: z.string().min(1),
      evidence: z.string().min(1),
      occurredAt: z.string().min(1),
      statedOccurredAt: z.string().min(1).optional(),
    })
    .optional(),
});

const Data = Payload.extend({
  decision: z.enum(['new', 'reuse', 'pinned']),
  /**
   * When this substrate accepted the push, fixed while the guard was held. World time comes off
   * the experience; every acceptance and readiness clock comes from here, so a backdated
   * conversation cannot date its own archive row, ingest position or reference receipt.
   */
  acceptedAt: z.string().min(1),
  /** The statements this push carried, classified under the guard. Empty when it carried none. */
  referenceTargets: z.array(ReferenceTarget),
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

/** The stated block a push carried, in the shape the shared acceptance normalizes to. */
function statedInput(stated: ReflectionContent['provenance']): StatedReferenceInput {
  return {
    supersedes: stated?.supersedes ?? [],
    derivedFrom: stated?.derived_from ?? [],
    confirmations: (stated?.confirmations ?? []).map((entry) => ({
      target: entry.target,
      by: entry.by,
      evidence: entry.evidence,
      ...(entry.occurred_at === undefined ? {} : { occurredAt: entry.occurred_at }),
    })),
  };
}

/** The delivery identity of the statements one acceptance carried. */
function referenceDeliveryKey(data: IntakeData): string {
  return `intake:${data.sourceId}:${acceptedTargetsHash(data.referenceTargets)}`;
}

function referenceAcceptanceOf(data: IntakeData, operationId: string): ReferenceAcceptance {
  return {
    sourceId: data.sourceId,
    targets: data.referenceTargets,
    deliveryKey: referenceDeliveryKey(data),
    operationId,
    acceptedAt: data.acceptedAt,
  };
}

/**
 * What acceptance owes once the graph commits.
 *
 * A reused occurrence is already projected, already queued and already indexed, so it owes none
 * of that. It still owes the statements this push carried: accepting a late reference against a
 * source that is already here, or already evicted, is the point of the contract.
 */
function acceptanceEffects(data: IntakeData): PublicationPlan<IntakeData>['effects'] {
  const detail = (value: JsonValue): JsonValue => value;
  const referenceEffects =
    data.decision === 'pinned'
      ? []
      : [
          { kind: INTAKE_EFFECTS.references, detail: detail({ sourceId: data.sourceId }) },
          ...(data.referenceTargets.length === 0
            ? []
            : [
                {
                  kind: INTAKE_EFFECTS.links,
                  detail: detail({ count: data.referenceTargets.length }),
                },
              ]),
        ];
  if (data.decision !== 'new') {
    return data.decision === 'reuse' ? referenceEffects : [];
  }
  return [
    ...referenceEffects,
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
): Omit<IntakeData, 'candidateDigest' | 'acceptedAt' | 'referenceTargets'> {
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
    INTAKE_EFFECTS.references,
    INTAKE_EFFECTS.links,
  ],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
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
    const stated = statedInput(references(payload));
    const retained = await presentNodeIds(context.graph, statedReferenceIds(stated));
    const data: IntakeData = {
      ...selected,
      acceptedAt: context.now.toISOString(),
      referenceTargets:
        selected.decision === 'pinned'
          ? []
          : classifyStatedReferences(context.db, stated, retained, context.now.toISOString()),
      candidateDigest: candidateDigest(context.db, key, selected.sourceId),
    };
    return {
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
    };
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
    if (data.decision === 'pinned') {
      return { sourceId: data.sourceId, created: false, turnIds: [] };
    }
    if (data.decision !== 'new') {
      // An evicted duplicate answers with the original id: nothing here rebuilds a projection
      // to satisfy a lookup, which is the rehydration the residency rules forbid. Its statements
      // still project, because a settlement reported without its edges is a settlement of
      // nothing when both endpoints are right here.
      await projectAcceptedReferences(
        context.graph,
        data.sourceId,
        data.referenceTargets,
        context.now,
      );
      return { sourceId: data.sourceId, created: false, turnIds: [] };
    }
    const stored = await projectEpisodeInTransaction(context.graph, {
      prepared: prepareEpisode(content(data), new Date(data.occurredAt)),
      sessionId: data.sessionId,
      origin: origin(data),
      now: context.now,
      identity: { episodeId: data.sourceId, turnIds: data.turnIds },
    });
    // After the episode exists, so a statement it carried has an end to hang on.
    await projectAcceptedReferences(
      context.graph,
      data.sourceId,
      data.referenceTargets,
      context.now,
    );
    return { sourceId: stored.episodeId, created: true, turnIds: [...data.turnIds] };
  },
  prepareSqlite(context: PublicationSqliteContext, data: IntakeData) {
    if (data.decision === 'pinned') {
      return undefined;
    }
    if (data.decision === 'new') {
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
          referenceDelivery: {
            key: referenceDeliveryKey(data),
            targets: data.referenceTargets,
            operationId: context.operationId,
          },
          readiness: data.readiness ?? undefined,
          now: new Date(data.acceptedAt),
        },
        data.turnIds,
      );
      return undefined;
    }
    // A reused occurrence rebuilds nothing and reindexes nothing, but the statements this push
    // carried are new and are accepted against the original source whatever its storage. The
    // same delivery key the new path prepares under, so one acknowledgment answers for both.
    prepareReferenceAcceptance(context.db, referenceAcceptanceOf(data, context.operationId));
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.decision === 'pinned') {
      return undefined;
    }
    const acceptance = referenceAcceptanceOf(data, context.operationId);
    const delivery = readReferenceDelivery(context.db, data.sourceId, acceptance.deliveryKey);
    if (delivery === undefined) {
      throw new Error(`intake ${context.operationId} acknowledged unaccepted references`);
    }
    acknowledgeReferenceAcceptance(context.db, {
      ...acceptance,
      knownFrom: context.knownFrom,
      observedAckAt: context.observedAckAt,
      referenceVersion: delivery.referenceVersion,
    });
    if (data.decision !== 'new') {
      return undefined;
    }
    const generation = readGeneration(context.db, data.sourceId, 1);
    if (generation === undefined) {
      throw new Error(`intake ${context.operationId} acknowledged with no prepared generation`);
    }
    const position = readIngestPosition(context.db, data.sourceId);
    activateSourceManifest(context.db, {
      sourceId: data.sourceId,
      processingGeneration: generation.processingGeneration,
      sessionId: data.sessionId,
      captureOrderValue: captureOrderValue(position ?? 0),
      now: new Date(context.knownFrom),
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
    discardReferenceAcceptance(context.db, referenceAcceptanceOf(data, context.operationId));
    return undefined;
  },
});

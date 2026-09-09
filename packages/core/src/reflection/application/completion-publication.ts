import { z } from 'zod';

import { recordStageSettlements } from './stage-settlement.js';
import { SOURCE_PART_KINDS } from '../../evidence/domain/address.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { JsonValue, PublicationContext } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import { completeReflectionJobForSource } from '../../infrastructure/sqlite/reflection-queue.js';
import { listReferenceBatches } from '../../infrastructure/sqlite/source-identity.js';
import {
  recordEvidenceAcknowledgment,
  SEMANTIC_PROCESSING_EFFECT,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { hashContent } from '../domain/content.js';
import {
  stageSettlementOf,
  STAGE_SETTLEMENT_REASONS,
  type ReflectionSummary,
  type StageRecord,
} from '../domain/stage.js';

/**
 * A finished reflection run, as a publication.
 *
 * What it settles is what the run owed: the stage obligations take their typed outcomes, the
 * source's semantic-processing effect is discharged against the reference version it was measured
 * on, and the queue row goes. All of it commits together, which is what makes the comparison mean
 * anything: a reference accepted while the run was working moves the version, the check refuses,
 * and the job stays claimable rather than completing over an update nobody made.
 *
 * The comparison is against the generation, readiness counter and accepted references the run
 * STARTED under, carried in the payload. A run whose generation was replaced while it worked
 * settles nothing: those obligations belong to the replacement, and an old worker cannot
 * discharge them. Neither does a run whose source began owing something new while it ran.
 */
export const COMPLETION_EFFECTS = {
  settlement: 'stage_settlement',
  queue: 'reflection_queue_completion',
} as const;

const Settlement = z.strictObject({
  disposition: z.enum(['complete', 'not_applicable']),
  reason: z.enum(STAGE_SETTLEMENT_REASONS),
  proof: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const Dependency = z.strictObject({
  kind: z.enum(['source', 'node', 'relation_scope']),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});

/**
 * A judgment the pass could not decide, with what it was about and what it was judged against.
 *
 * It travels whole. The nodes name the pair, the addresses name the parts a rebuild would read
 * it back through, and the revision is the evidence the abstention rests on; a completion that
 * carried only a count would close the row over work nobody can find again.
 */
const Withheld = z.strictObject({
  nodeIds: z.array(z.string().min(1)),
  disposition: z.enum(['blocked', 'retryable']),
  reason: z.string(),
  addresses: z.array(
    z.union([
      z.strictObject({ kind: z.literal('id'), id: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('part'),
        sourceId: z.string().min(1),
        partKind: z.enum(SOURCE_PART_KINDS),
        ordinal: z.number().int().nonnegative(),
      }),
    ]),
  ),
  revision: z.strictObject({
    contractVersion: z.literal(1),
    dependencies: z.array(Dependency),
    digest: z.string(),
  }),
});

const Stage = z.strictObject({
  name: z.string().min(1),
  status: z.enum(['ok', 'failed', 'skipped']),
  summary: z.string(),
  /** The pass asked to be re-entered. It settles nothing whatever else it wrote. */
  retryable: z.boolean().optional(),
  withheldWork: z.array(Withheld).optional(),
  settled: Settlement.optional(),
  settledOnUpstream: Settlement.optional(),
});

const Payload = z.strictObject({
  sourceId: z.string().min(1),
  /** The queue row this completion closes. Empty where the run had none, which a replay does. */
  jobId: z.string(),
  stages: z.array(Stage),
  /**
   * The generation the run's obligations belong to, read before the run started. Zero where the
   * source had none: a legacy row the identity census has not reached still owes its queue row a
   * completion, and it owes no stage outcomes because nothing recorded what it should have run.
   */
  processingGeneration: z.number().int().nonnegative(),
  /** The readiness counter the run started under. A change means the generation owes something new. */
  operationalRevision: z.number().int().nonnegative(),
  /** The newest accepted reference batch when the run started. */
  acceptedReferenceVersion: z.number().int().nonnegative(),
  /** What the archive held for this source when the run started. */
  referencesDigest: z.string(),
});

/**
 * The binding is the payload. Prepare copies it rather than reading the stores again, because a
 * fresh read there is a read of the state the run finished into, and comparing that with itself
 * accepts every replacement and every newly owed row as the run's own input.
 */
const Data = Payload;

const Result = z.strictObject({
  settledStages: z.array(z.string()),
  /** The queue row the acknowledgment closes, empty where the run carried none. */
  completedJobId: z.string(),
});

type CompletionData = z.infer<typeof Data>;

function json(value: JsonValue): JsonValue {
  return value;
}

/**
 * One comparable value for the statements the archive holds for this source, or an empty one
 * where it holds none.
 *
 * A source accepted through the acceptance operation records its statements as their own batch
 * and leaves none in the archive payload, so this is empty for everything accepted since. It is
 * still read and still compared, because a legacy row written before that split does carry them
 * and a completion must not settle over one that moved.
 *
 * Comparing it settles nothing about those statements. A legacy payload's statements are owed
 * until the guarded legacy producer accepts them, and it is what records that they landed.
 */
function referencesDigest(db: PublicationContext['db'], sourceId: string): string {
  const references = getExperienceByEpisode(db, sourceId)?.payload.provenance;
  return references === undefined ? '' : hashContent(references);
}

function latestReferenceVersion(db: PublicationContext['db'], sourceId: string): number {
  const batches = listReferenceBatches(db, sourceId);
  return batches[batches.length - 1]?.referenceVersion ?? 0;
}

/** What a run's obligations were measured against, read before the run starts. */
export type CompletionBinding = {
  readonly processingGeneration: number;
  readonly operationalRevision: number;
  readonly acceptedReferenceVersion: number;
  readonly referencesDigest: string;
};

/**
 * Reads the binding a completion is compared under.
 *
 * The caller takes this before it starts the run, and the values travel in the payload. A
 * generation replaced during the run, or a row the generation started owing after it began, then
 * shows up as a difference under the final guard instead of being read back as the run's own
 * input.
 */
export function completionBinding(db: SqliteHandle, sourceId: string): CompletionBinding {
  const generation = readActiveGeneration(db, sourceId);
  return {
    processingGeneration: generation?.processingGeneration ?? 0,
    operationalRevision: generation?.operationalRevision ?? 0,
    acceptedReferenceVersion: latestReferenceVersion(db, sourceId),
    referencesDigest: referencesDigest(db, sourceId),
  };
}

/** One stage's line in a completion payload: what it did, and what it left owed. */
export type CompletionStage = Pick<StageRecord, 'name' | 'status' | 'summary'> &
  Partial<Pick<StageRecord, 'retryable' | 'withheldWork' | 'settled' | 'settledOnUpstream'>>;

/**
 * The run summary a completion carries, narrowed to what the plan records.
 *
 * The remainder travels with it. A pass that named withheld pairs or asked to be re-entered
 * leaves work the row owes, and a payload that dropped either would close the row over a
 * judgment nobody could ask about again.
 */
export function completionStages(summary: ReflectionSummary): readonly CompletionStage[] {
  return summary.stages.map((stage: StageRecord) => ({
    name: stage.name,
    status: stage.status,
    summary: stage.summary,
    ...(stage.retryable === undefined ? {} : { retryable: stage.retryable }),
    ...(stage.withheldWork === undefined ? {} : { withheldWork: stage.withheldWork }),
    ...(stage.settled === undefined ? {} : { settled: stage.settled }),
    ...(stage.settledOnUpstream === undefined
      ? {}
      : { settledOnUpstream: stage.settledOnUpstream }),
  }));
}

export const reflectionCompletionPublication = new PublicationOperation({
  kind: 'reflection_completion',
  effectKinds: [COMPLETION_EFFECTS.settlement, COMPLETION_EFFECTS.queue],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('a completion cannot publish before the coverage registry exists');
    }
    const data: CompletionData = payload;
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([
          {
            kind: 'source',
            id: payload.sourceId,
            scope: 'source.references',
            version: String(payload.acceptedReferenceVersion),
          },
        ]),
        sources:
          payload.processingGeneration === 0
            ? []
            : [
                {
                  sourceId: payload.sourceId,
                  generation: String(payload.processingGeneration),
                  acceptedReferenceVersion: String(payload.acceptedReferenceVersion),
                },
              ],
        heads: [],
      },
      scopes: [{ kind: 'source', id: payload.sourceId, scope: 'source.references' }],
      // The queue effect is declared only where there is a row to complete. A replay carries no
      // job id, and an effect nothing performs is a claim the receipt cannot support.
      effects: [
        { kind: COMPLETION_EFFECTS.settlement, detail: json({ sourceId: payload.sourceId }) },
        ...(payload.jobId === ''
          ? []
          : [{ kind: COMPLETION_EFFECTS.queue, detail: json({ jobId: payload.jobId }) }]),
      ],
    });
  },
  check(context, data) {
    const generation = readActiveGeneration(context.db, data.sourceId);
    if (
      (generation?.processingGeneration ?? 0) !== data.processingGeneration ||
      (generation?.operationalRevision ?? 0) !== data.operationalRevision
    ) {
      // The generation was replaced, or it owes something it did not owe when the run finished.
      // Either way this completion is about a different set of obligations.
      return Promise.resolve({ status: 'deferred', reason: 'readiness_moved' } as const);
    }
    if (latestReferenceVersion(context.db, data.sourceId) !== data.acceptedReferenceVersion) {
      return Promise.resolve({ status: 'deferred', reason: 'reference_accepted' } as const);
    }
    if (referencesDigest(context.db, data.sourceId) !== data.referencesDigest) {
      return Promise.resolve({ status: 'deferred', reason: 'references_changed' } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  applyGraph(_context: PublicationContext, data: CompletionData) {
    // A completion writes no graph. It takes the guard so the comparison below is fenced: a
    // reference accepted while this attempt is held cannot land between the check and the
    // acknowledgment, which is exactly the window a completion outside the protocol left open.
    //
    // The result names what the acknowledgment settles: the stages the run declared a typed
    // disposition for, and the queue row it closes.
    return Promise.resolve({
      settledStages: data.stages
        .filter((stage) => stageSettlementOf(stage) !== undefined)
        .map((stage) => stage.name),
      completedJobId: data.jobId,
    });
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    // Inside the acknowledgment, beside the queue row: a completion that rolls back leaves the
    // obligations exactly as it found them, and a stage that settled nothing keeps its row.
    recordStageSettlements(
      context.db,
      data.sourceId,
      {
        episodeId: data.sourceId,
        durationMs: 0,
        // A settlement carries dispositions, not timings: the run's own log holds those.
        stages: data.stages.map((stage) => ({ ...stage, durationMs: 0 })),
        counts: {},
        skippedStages: [],
      },
      new Date(context.knownFrom),
    );
    // The queue row goes here rather than back in the worker, so the effect the handler
    // declares is the effect the acknowledgment performs and a recovery finishes the job
    // without the run that claimed it.
    if (data.jobId !== '') {
      completeReflectionJobForSource(context.db, data.jobId, data.sourceId);
    }
    recordEvidenceAcknowledgment(context.db, {
      sourceId: data.sourceId,
      referenceVersion: data.acceptedReferenceVersion,
      effectKind: SEMANTIC_PROCESSING_EFFECT,
      state: 'completed',
      completedAt: new Date(context.knownFrom),
    });
    return undefined;
  },
  discardSqlite() {
    // Nothing durable was prepared: a refused completion leaves the queue row claimable and
    // every obligation exactly where the run found it.
    return undefined;
  },
});

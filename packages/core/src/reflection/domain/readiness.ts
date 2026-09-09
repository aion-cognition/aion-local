/**
 * Whether a source's required processing pass is done, decided from the policy it was accepted
 * under and the obligations its active generation holds.
 *
 * Three answers, not two. `complete` means every stage the policy required carries a typed
 * outcome and nothing else is owed. `incomplete` means something is owed and the records say
 * what. `unknown` means the records cannot answer: no active generation, a policy nothing
 * published, a stage with no row at all. An inventory nobody wrote is not an inventory of
 * nothing, and the difference is what keeps an unprocessed source from passing for a finished
 * one.
 *
 * Row presence is never the test. A completed stage carries its outcome, so a row without one
 * says nothing about whether its stage happened.
 */

/** The work states the store holds, as the CHECK constraint enumerates them. */
export type SourceWorkState =
  'pending' | 'retryable' | 'transferred' | 'completed' | 'obsolete' | 'pinned' | 'dead_letter';

/** The typed outcome a completed row carries. */
export type RecordedOutcome = {
  readonly outcome: 'complete' | 'not_applicable';
  readonly reason: string;
  readonly proof?: Record<string, unknown>;
};

export type RecordedWork = {
  readonly workId: string;
  readonly kind: string;
  readonly stageName: string | null;
  readonly workKey: string;
  readonly state: SourceWorkState;
  readonly reason: string | null;
  /** Absent when the row carries none, which is a different answer from an empty one. */
  readonly outcome: RecordedOutcome | undefined;
};

export type StageDisposition =
  'complete' | 'not_applicable' | 'pending' | 'retryable' | 'transferred' | 'pinned' | 'unrecorded';

export type StageReadiness = {
  readonly stageName: string;
  readonly disposition: StageDisposition;
  readonly reason: string;
};

export type ReadinessCompleteness = 'complete' | 'incomplete' | 'unknown';

export type ProcessingReadiness = {
  readonly sourceId: string;
  /** Absent when no generation is active, which is itself an unknown answer. */
  readonly processingGeneration: number | undefined;
  readonly policyRevision: number | undefined;
  readonly inputDigest: string | null | undefined;
  /** The counter a proof binds to. A later change to what the generation owes moves it. */
  readonly operationalRevision: number | undefined;
  readonly stages: readonly StageReadiness[];
  readonly outstandingWorkIds: readonly string[];
  readonly completeness: ReadinessCompleteness;
  /** Why the answer is what it is, one entry per contributing record. */
  readonly reasons: readonly string[];
};

export type ReadinessInput = {
  readonly sourceId: string;
  readonly generation:
    | {
        readonly processingGeneration: number;
        readonly policyRevision: number;
        readonly inputDigest: string | null;
        readonly operationalRevision: number;
      }
    | undefined;
  /** The stage set the source's own policy revision required, not today's. */
  readonly requiredStages: readonly string[] | undefined;
  readonly work: readonly RecordedWork[];
};

/** States that still owe something. `pinned` owes work nothing can currently run. */
const OUTSTANDING: readonly SourceWorkState[] = [
  'pending',
  'retryable',
  'transferred',
  'pinned',
  'dead_letter',
];

function isOutstanding(state: SourceWorkState): boolean {
  return OUTSTANDING.includes(state);
}

/**
 * One stage's disposition from its row. A completed row without a typed outcome is unrecorded
 * rather than complete: the store's CHECK makes that shape unreachable for a stage row, and
 * treating it as complete anywhere else would let a repair write settle a pass it never ran.
 */
function dispositionOf(row: RecordedWork): StageReadiness {
  const stageName = row.stageName ?? row.workKey;
  if (row.state === 'completed') {
    if (row.outcome === undefined) {
      return { stageName, disposition: 'unrecorded', reason: 'completed with no typed outcome' };
    }
    return {
      stageName,
      disposition: row.outcome.outcome === 'complete' ? 'complete' : 'not_applicable',
      reason: row.outcome.reason,
    };
  }
  if (row.state === 'obsolete') {
    return { stageName, disposition: 'unrecorded', reason: 'obsolete under the active generation' };
  }
  if (row.state === 'dead_letter') {
    return { stageName, disposition: 'retryable', reason: row.reason ?? 'dead letter' };
  }
  return { stageName, disposition: row.state, reason: row.reason ?? row.state };
}

/**
 * The readiness of one source, from the records alone.
 *
 * The required stage set comes from the source's OWN policy revision. A pipeline that gained a
 * stage since this source was accepted did not change what this source's accepted pass was, and
 * evaluating it against today's list would re-open a pass that finished.
 */
export function evaluateProcessingReadiness(input: ReadinessInput): ProcessingReadiness {
  const reasons: string[] = [];
  const { generation } = input;
  if (generation === undefined) {
    return {
      sourceId: input.sourceId,
      processingGeneration: undefined,
      policyRevision: undefined,
      inputDigest: undefined,
      operationalRevision: undefined,
      stages: [],
      outstandingWorkIds: [],
      completeness: 'unknown',
      reasons: ['no active processing generation'],
    };
  }

  const byStage = new Map<string, RecordedWork>();
  for (const row of input.work) {
    if (row.kind === 'stage' && row.stageName !== null) {
      byStage.set(row.stageName, row);
    }
  }

  const stages: StageReadiness[] = [];
  let unknown = input.requiredStages === undefined;
  if (input.requiredStages === undefined) {
    reasons.push(`policy revision ${String(generation.policyRevision)} is not readable`);
  }
  for (const stageName of input.requiredStages ?? []) {
    const row = byStage.get(stageName);
    if (row === undefined) {
      stages.push({ stageName, disposition: 'unrecorded', reason: 'no row for a required stage' });
      reasons.push(`required stage ${stageName} has no row`);
      unknown = true;
      continue;
    }
    const readiness = dispositionOf(row);
    stages.push(readiness);
    if (readiness.disposition === 'unrecorded') {
      reasons.push(`required stage ${stageName} is ${readiness.reason}`);
      unknown = true;
    }
  }

  const outstanding = input.work.filter((row) => isOutstanding(row.state));
  for (const row of outstanding) {
    reasons.push(`${row.kind}:${row.workKey} is ${row.state}`);
  }
  // An inventory obligation is the record of an inventory nobody could write. It owes work AND
  // makes the stage list unaccountable, so it answers unknown rather than merely incomplete.
  if (outstanding.some((row) => row.kind === 'inventory')) {
    unknown = true;
  }

  const settled: ReadinessCompleteness = outstanding.length === 0 ? 'complete' : 'incomplete';
  const completeness: ReadinessCompleteness = unknown ? 'unknown' : settled;
  return {
    sourceId: input.sourceId,
    processingGeneration: generation.processingGeneration,
    policyRevision: generation.policyRevision,
    inputDigest: generation.inputDigest,
    operationalRevision: generation.operationalRevision,
    stages,
    outstandingWorkIds: outstanding.map((row) => row.workId),
    completeness,
    reasons,
  };
}

/**
 * Whether this source is mature evidence for sampling: every required stage carries complete or
 * a proved not-applicable, and nothing is pending, retryable, pinned or still transferred.
 *
 * Stricter than eviction on purpose. Eviction may accept a supported registered transfer;
 * a sample scored against work still in flight measures a pipeline that has not finished.
 */
export function readinessSupportsSampling(readiness: ProcessingReadiness): boolean {
  return readiness.completeness === 'complete';
}

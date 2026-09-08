import type { ActivationTermination } from './activation.js';
import type { AdmissionReport } from './admission.js';
import type { PackDecision } from './pack-decisions.js';
import type { SeedStrategy } from './seed-selection.js';

/**
 * What one recall run did, stage by stage, for a reader comparing two runs.
 *
 * Every set here is read off a value the pipeline already produced. Nothing is recomputed: a
 * second admission calculation running beside the real one would eventually disagree with it,
 * and then the trace would describe a pipeline nobody ships.
 *
 * A set larger than the cap is cut and says so. A truncated set can show that an id was
 * present; it can never show that one was absent, and the flag is what stops a reader drawing
 * the second conclusion from the first.
 */

/** Ids beyond this per stage are cut from the trace. The total and the flag survive. */
export const TRACE_ID_CAP = 200;

export type TraceIdSet = {
  readonly ids: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
};

export function traceIds(ids: Iterable<string>, cap: number = TRACE_ID_CAP): TraceIdSet {
  const all = [...ids];
  return {
    ids: all.slice(0, cap),
    total: all.length,
    truncated: all.length > cap,
  };
}

/** One candidate as a leg scored it, on that leg's own scale. */
export type SeedCandidateTrace = {
  readonly id: string;
  readonly score: number;
  readonly relevance: number;
};

export type SeedLegTrace = {
  readonly strategy: SeedStrategy;
  readonly candidates: TraceIdSet;
  /**
   * Per candidate, not only the leg's maximum. Two runs disagreeing about one node cannot be
   * read off a maximum, which moves when any candidate moves.
   */
  readonly scored: readonly SeedCandidateTrace[];
  readonly scoredTruncated: boolean;
  /** The leg's own best numbers, as the leg reported them. */
  readonly bestScore?: number;
  readonly bestRelevance?: number;
};

/** The vantage the run read from, as the run bound it, not as a name for it. */
export type TraceReadMode = {
  readonly code: string;
  readonly validAt?: string;
  readonly knownAt?: string;
  readonly reference?: string;
  readonly expiryAnnotation?: boolean;
};

/** What the run generated and embedded against, as the routing rule actually resolved it. */
export type TraceRoute = {
  readonly cueProvider: string;
  readonly cueModel: string;
  readonly cueReason: string;
  readonly embedModel: string;
};

export type ActivationTrace = TraceIdSet & {
  readonly iterations: number;
  readonly nodesVisited: number;
  readonly termination: ActivationTermination;
};

export type RecallTrace = {
  /** Resolved by the session manager, which is what makes an independence check possible. */
  readonly sessionId: string;
  readonly sampledAt: string;
  readonly readMode: TraceReadMode;
  readonly queryDigest: string;
  /** Over the whole configuration, secrets excluded, so no setting drifts unnoticed. */
  readonly configDigest: string;
  readonly route: TraceRoute;
  readonly seedLegs: readonly SeedLegTrace[];
  readonly activation: ActivationTrace;
  /** What fusion admitted, before the serving-layer subtractions run. */
  readonly fusion: TraceIdSet;
  readonly admission: AdmissionReport;
  /** Every candidate assembly was offered: fusion, resonance and intention triggers together. */
  readonly preAssembly: TraceIdSet;
  readonly withheldOwn: TraceIdSet;
  readonly withheldRepeat: TraceIdSet;
  /** Candidates a copy could stand in for. Eligibility, which is what this stage decides. */
  readonly foldEligible: TraceIdSet;
  /**
   * How many the pack actually folded. Assembly makes that call while it walks its own serving
   * order and keeps the count rather than the ids, so the count is what the run holds and the
   * trace reports it instead of deciding the fold a second time and disagreeing.
   */
  readonly foldedCount: number;
  /**
   * Offered to assembly and not printed, with the two subtractions above already taken out.
   * The folded copies and whatever the bucket caps and the token budget turned away are in
   * here together, because nothing in the run separates them by id.
   */
  readonly withheldRemainder: TraceIdSet;
  /**
   * What assembly decided, per candidate, in the order it decided. This is where a fold, a
   * bucket cap and the token budget become different answers rather than one remainder.
   */
  readonly assemblyDecisions: readonly PackDecision[];
  readonly assemblyDecisionsTruncated: boolean;
  readonly emitted: TraceIdSet;
};

/**
 * A sink may be asynchronous, and one that rejects after this call returns is still a broken
 * diagnostic rather than a broken recall, so the contract says so and the caller catches it.
 */
export type RecallTraceObserver = (trace: RecallTrace) => void | Promise<void>;

export type SeedLegInput = {
  readonly strategy: SeedStrategy;
  readonly candidates: readonly SeedCandidateTrace[];
};

export type RecallTraceInput = {
  readonly sessionId: string;
  readonly sampledAt: string;
  readonly readMode: TraceReadMode;
  readonly queryDigest: string;
  readonly configDigest: string;
  readonly route: TraceRoute;
  readonly seedLegs: readonly SeedLegInput[];
  readonly activated: readonly { readonly nodeId: string }[];
  readonly activationIterations: number;
  readonly activationNodesVisited: number;
  readonly activationTermination: ActivationTermination;
  readonly fused: readonly { readonly id: string }[];
  readonly admission: AdmissionReport;
  readonly preAssembly: readonly string[];
  readonly withheldOwn: ReadonlySet<string>;
  readonly withheldRepeat: ReadonlySet<string>;
  readonly foldEligible: Iterable<string>;
  readonly foldedCount: number;
  readonly assemblyDecisions: readonly PackDecision[];
  readonly emitted: ReadonlySet<string>;
};

function bestOf(
  candidates: SeedLegInput['candidates'],
  field: 'score' | 'relevance',
): number | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.reduce((best, candidate) => Math.max(best, candidate[field]), -Infinity);
}

export function buildRecallTrace(input: RecallTraceInput, cap: number = TRACE_ID_CAP): RecallTrace {
  const remainder = input.preAssembly.filter(
    (id) => !input.emitted.has(id) && !input.withheldOwn.has(id) && !input.withheldRepeat.has(id),
  );

  return {
    sessionId: input.sessionId,
    sampledAt: input.sampledAt,
    readMode: input.readMode,
    queryDigest: input.queryDigest,
    configDigest: input.configDigest,
    route: input.route,
    seedLegs: input.seedLegs.map((leg) => {
      const bestScore = bestOf(leg.candidates, 'score');
      const bestRelevance = bestOf(leg.candidates, 'relevance');
      return {
        strategy: leg.strategy,
        candidates: traceIds(
          leg.candidates.map((candidate) => candidate.id),
          cap,
        ),
        scored: leg.candidates.slice(0, cap),
        scoredTruncated: leg.candidates.length > cap,
        ...(bestScore === undefined ? {} : { bestScore }),
        ...(bestRelevance === undefined ? {} : { bestRelevance }),
      };
    }),
    activation: {
      ...traceIds(
        input.activated.map((node) => node.nodeId),
        cap,
      ),
      iterations: input.activationIterations,
      nodesVisited: input.activationNodesVisited,
      termination: input.activationTermination,
    },
    fusion: traceIds(
      input.fused.map((item) => item.id),
      cap,
    ),
    admission: input.admission,
    preAssembly: traceIds(input.preAssembly, cap),
    withheldOwn: traceIds(input.withheldOwn, cap),
    withheldRepeat: traceIds(input.withheldRepeat, cap),
    foldEligible: traceIds(input.foldEligible, cap),
    foldedCount: input.foldedCount,
    withheldRemainder: traceIds(remainder, cap),
    assemblyDecisions: input.assemblyDecisions.slice(0, cap),
    assemblyDecisionsTruncated: input.assemblyDecisions.length > cap,
    emitted: traceIds(input.emitted, cap),
  };
}

export type SubsetVerdict = 'within' | 'outside' | 'indeterminate';

/**
 * Whether what the pack printed is a subset of what assembly was offered.
 *
 * A truncated set proves nothing either way, so it answers `indeterminate` rather than
 * reporting the check as passed. A pack outside the offered set is describing an item no stage
 * nominated, which is a defect in the instrumentation or in the pipeline and either way not a
 * reading anybody should compare.
 */
export function emittedSubsetVerdict(trace: RecallTrace): SubsetVerdict {
  if (trace.preAssembly.truncated || trace.emitted.truncated) {
    return 'indeterminate';
  }
  const offered = new Set(trace.preAssembly.ids);
  return trace.emitted.ids.every((id) => offered.has(id)) ? 'within' : 'outside';
}

/** True only on proof. An indeterminate check is not a passed one. */
export function emittedWithinCandidates(trace: RecallTrace): boolean {
  return emittedSubsetVerdict(trace) === 'within';
}

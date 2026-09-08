import type { ActivationTermination } from './activation.js';
import type { AdmissionReport } from './admission.js';
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

export type SeedLegTrace = {
  readonly strategy: SeedStrategy;
  readonly candidates: TraceIdSet;
  /** The leg's own best numbers, on the leg's own scale, as the leg reported them. */
  readonly bestScore?: number;
  readonly bestRelevance?: number;
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
  /** `default`, or the vantage a time-traveled read bound the whole run to. */
  readonly readMode: string;
  readonly queryDigest: string;
  readonly configDigest: string;
  readonly providerDigest: string;
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
  readonly emitted: TraceIdSet;
};

export type RecallTraceObserver = (trace: RecallTrace) => void;

export type SeedLegInput = {
  readonly strategy: SeedStrategy;
  readonly candidates: readonly {
    readonly id: string;
    readonly score: number;
    readonly relevance: number;
  }[];
};

export type RecallTraceInput = {
  readonly sessionId: string;
  readonly sampledAt: string;
  readonly readMode: string;
  readonly queryDigest: string;
  readonly configDigest: string;
  readonly providerDigest: string;
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
    providerDigest: input.providerDigest,
    seedLegs: input.seedLegs.map((leg) => {
      const bestScore = bestOf(leg.candidates, 'score');
      const bestRelevance = bestOf(leg.candidates, 'relevance');
      return {
        strategy: leg.strategy,
        candidates: traceIds(
          leg.candidates.map((candidate) => candidate.id),
          cap,
        ),
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
    emitted: traceIds(input.emitted, cap),
  };
}

/**
 * Whether what the pack printed is a subset of what assembly was offered. A trace that fails
 * this is describing a pack holding an item no stage nominated, which is a defect in the
 * instrumentation or in the pipeline, and either way not a reading anybody should compare.
 */
export function emittedWithinCandidates(trace: RecallTrace): boolean {
  if (trace.preAssembly.truncated || trace.emitted.truncated) {
    return true;
  }
  const offered = new Set(trace.preAssembly.ids);
  return trace.emitted.ids.every((id) => offered.has(id));
}

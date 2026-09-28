import type {
  AssessmentReport,
  Cue,
  Degradation,
  MemoryPack,
  StageTimingsMs,
} from '@aion/protocol';
import { createHash } from 'node:crypto';

import type { triggeredIntentions } from './intentions.js';
import type { ResonanceResult } from './resonance.js';
import type { Seed, SeedStrategy } from './seeds.js';
import type { ServedAnswer } from './serving-assembly.js';
import { configDigest } from '../../infrastructure/config/digest.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { resolveProviderRouting } from '../../infrastructure/providers/routing.js';
import type {
  BridgeLegContribution,
  HubPenaltyObserved,
} from '../domain/activation-observations.js';
import type { ActivatedNode, ActivationRun } from '../domain/activation.js';
import type { AdmissionReport } from '../domain/admission.js';
import type { FusedItem, FusionResult } from '../domain/fusion.js';
import type { PackDecision } from '../domain/pack-decisions.js';
import {
  buildRecallTrace,
  type RecallTrace,
  type RecallTraceObserver,
  type TraceReadMode,
  type TraceRoute,
} from '../domain/recall-trace.js';

/**
 * The two seams a finished recall reports through: the production listener, which may write,
 * and the diagnostic trace, which may not.
 *
 * Both are absent by default. The trace exists so two runs can be compared stage by stage
 * without adding a provider call, a seed query, or a listener invocation to either of them:
 * everything it reports is a value the run already produced, read once at the end in the order
 * the stages ran.
 */

export type RecallCompletion = {
  readonly sessionId: string;
  readonly seeds: readonly Seed[];
  /** The co-activated set, seeds included. Telemetry: the spread reached it, nobody read it. */
  readonly activated: readonly ActivatedNode[];
  /**
   * Every candidate assembly was offered, in the order the three passes produced them: fusion,
   * then resonance, then the intention triggers. Telemetry, and the whole of it, because read
   * against `emitted` the difference is what the caps and the subtractions cost this pack.
   */
  readonly retrieved: readonly string[];
  /**
   * The ids this pack printed, which is what the caller was handed and the one population an
   * exposure write may be charged against.
   */
  readonly emitted: ReadonlySet<string>;
  /** What the admission gate dropped and the floors it used, for a caller that reports honesty signals. */
  readonly admission: AdmissionReport;
  readonly pack: MemoryPack;
  readonly now: Date;
  /** Every bridge leg this walk's propagation crossed. Telemetry, read by the traversal sense only. */
  readonly bridgeLegs: readonly BridgeLegContribution[];
  /** This walk's hub-inhibition exposure, summarized. Telemetry, read by the density sense only. */
  readonly hubPenalty: HubPenaltyObserved;
  /**
   * The bitemporal vantage point the whole run read from. A listener that writes consults it:
   * inspecting the past is a question, not a use, so it must not stamp `last_accessed` on
   * historical nodes or strengthen edges as though the memory had just fired.
   */
  readonly mode: ReadMode;
};

/**
 * Fired after the pack is persisted and never awaited, so a rejected listener cannot fail
 * a recall that already succeeded. The reinforcement hooks attach here; a listener that does
 * real work owes it to the caller to schedule it rather than run it inline, since a
 * synchronous listener still runs before the pack returns.
 */
export type RecallListener = (completion: RecallCompletion) => void | Promise<void>;

export function notifyRecalled(
  listener: RecallListener | undefined,
  logger: Logger,
  completion: RecallCompletion,
): void {
  if (listener === undefined) {
    return;
  }
  try {
    const result = listener(completion);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        logger.warn({ err }, 'recall listener failed');
      });
    }
  } catch (err) {
    logger.warn({ err }, 'recall listener failed');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * What the run's cue call could reach. A substrate with no key extracts no cues at all, so the
 * trace records that rather than a model name the call never sent anything to.
 */
function routeOf(config: Config): TraceRoute {
  const routing = resolveProviderRouting(config);
  return {
    cueProvider: routing.roles.cue.provider,
    cueModel: routing.roles.cue.model,
    cueReason: routing.roles.cue.available ? 'key' : 'no-key',
    embedModel: routing.embedModel,
  };
}

/**
 * The vantage the whole run was bound to, with its clocks. A name for the mode says which kind
 * of question was asked and not which moment it was asked about, and two historical runs an
 * hour apart are two different reads.
 */
function readModeOf(mode: ReadMode): TraceReadMode {
  const world = mode.validAt !== undefined;
  const system = mode.knownAt !== undefined;
  let code = 'default';
  if (world && system) {
    code = 'as_of+knew_at';
  } else if (world) {
    code = 'as_of';
  } else if (system) {
    code = 'knew_at';
  }
  return {
    code,
    ...(mode.validAt === undefined ? {} : { validAt: mode.validAt.toISOString() }),
    ...(mode.knownAt === undefined ? {} : { knownAt: mode.knownAt.toISOString() }),
    ...(mode.reference === undefined ? {} : { reference: mode.reference.toISOString() }),
    ...(mode.expiryAnnotation === undefined ? {} : { expiryAnnotation: mode.expiryAnnotation }),
  };
}

export type RecallStageValues = {
  readonly sessionId: string;
  readonly query: string;
  readonly mode: ReadMode;
  readonly sampledAt: Date;
  readonly byStrategy: Readonly<Record<SeedStrategy, readonly Seed[]>>;
  readonly activation: ActivationRun;
  readonly fused: readonly FusedItem[];
  readonly admission: AdmissionReport;
  readonly preAssembly: readonly string[];
  readonly withheldOwn: ReadonlySet<string>;
  readonly withheldRepeat: ReadonlySet<string>;
  readonly foldEligible: ReadonlyMap<string, ReadonlySet<string>>;
  readonly foldedCount: number;
  readonly assemblyDecisions: readonly PackDecision[];
  readonly emitted: ReadonlySet<string>;
};

/**
 * Builds the trace and hands it over, or does nothing at all when nobody is observing.
 *
 * A diagnostic sink that throws is a broken diagnostic, not a broken recall. The pack is
 * already assembled and persisted by the time this runs, so a failure here is logged and the
 * call carries on: the caller keeps its answer and the production listener still runs.
 */
export function emitRecallTrace(
  observer: RecallTraceObserver | undefined,
  logger: Pick<Logger, 'warn'>,
  config: Config,
  values: RecallStageValues,
): RecallTrace | undefined {
  if (observer === undefined) {
    return undefined;
  }
  try {
    const trace = buildRecallTrace({
      sessionId: values.sessionId,
      sampledAt: values.sampledAt.toISOString(),
      readMode: readModeOf(values.mode),
      queryDigest: digest(values.query),
      configDigest: configDigest(config),
      route: routeOf(config),
      seedLegs: Object.entries(values.byStrategy).map(([strategy, seeds]) => ({
        strategy: strategy as SeedStrategy,
        candidates: seeds,
      })),
      activated: values.activation.activated,
      activationIterations: values.activation.iterations,
      activationNodesVisited: values.activation.nodesVisited,
      activationTermination: values.activation.termination,
      fused: values.fused,
      admission: values.admission,
      preAssembly: values.preAssembly,
      withheldOwn: values.withheldOwn,
      withheldRepeat: values.withheldRepeat,
      foldEligible: values.foldEligible.keys(),
      foldedCount: values.foldedCount,
      assemblyDecisions: values.assemblyDecisions,
      emitted: values.emitted,
    });
    const result = observer(trace);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        logger.warn({ err }, 'recall trace observer failed');
      });
    }
    return trace;
  } catch (err) {
    logger.warn({ err }, 'recall trace observer failed');
    return undefined;
  }
}

export type ServedLog = {
  readonly sessionId: string;
  readonly cues: readonly Cue[];
  readonly degradations: readonly Degradation[];
  readonly seeds: readonly Seed[];
  readonly activation: ActivationRun;
  readonly fusion: FusionResult;
  readonly resonance: ResonanceResult;
  readonly intentions: Awaited<ReturnType<typeof triggeredIntentions>>;
  readonly serving: ServedAnswer;
  readonly emitted: ReadonlySet<string>;
  readonly timings: StageTimingsMs;
  readonly assessment?: AssessmentReport;
};

/** The one log line a finished recall writes, split out of `recall.ts` at its size cap. */
export function logServed(
  logger: Pick<Logger, 'info'>,
  withheld: boolean,
  values: ServedLog,
): void {
  const { serving, fusion, resonance, intentions } = values;
  const degradations = [
    ...values.degradations,
    ...(serving.pack.metadata.degraded ?? []).filter((rung) => rung.stage === 'assessment'),
  ];
  logger.info(
    {
      sessionId: values.sessionId,
      cues: values.cues.length,
      degraded: degradations.length > 0,
      degradations,
      seeds: values.seeds.length,
      activated: values.activation.activated.length,
      termination: values.activation.termination,
      items: fusion.items.length,
      resonant: resonance.items.length,
      // What the substrate volunteered, and why it volunteered nothing when it did not.
      intentions: intentions.items.length,
      intentionsSkipped: intentions.skipped,
      // What the wire dropped that cognition still counted, so a pack that shrank mid-session
      // reads as the subtraction rather than as retrieval going quiet.
      suppressedRepeats: serving.suppressed.size,
      // The other half of the same reading: how much of the answer was this session quoting
      // itself, which is a number worth watching as the conversation gets long.
      suppressedOwn: serving.suppressedOwn.size,
      // And the third: one assertion the substrate holds twice, printed once. Read off the
      // pack, because eligibility is decided here and the withholding is decided by assembly.
      suppressedDuplicates: serving.pack.metadata.suppressed_duplicates ?? 0,
      // What the caller was handed, which is the number every exposure write is charged
      // against. Beside the candidate count it reads as how much of retrieval reached the wire.
      emitted: values.emitted.size,
      // Why the second pass was quiet: a setting, a query nothing anchored, or a substrate
      // whose enrichment has not written the context vectors yet. Absent when it searched.
      resonanceSkipped: resonance.skipped,
      // What the floor rejected and the floor it used, so a thin pack is readable from the
      // log without re-running the query.
      admission: fusion.admission,
      // What the recall model was shown and chose, which is what a surprising pack is read against.
      ...(values.assessment === undefined ? {} : { assessment: values.assessment }),
      tokenEstimate: serving.pack.metadata.token_estimate,
      timings: values.timings,
    },
    withheld ? 'recall withheld' : 'recall served',
  );
}

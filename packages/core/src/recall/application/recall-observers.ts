import type { MemoryPack } from '@aion/protocol';
import { createHash } from 'node:crypto';

import type { Seed, SeedStrategy } from './seeds.js';
import type { Config } from '../../infrastructure/config/schema.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { ActivatedNode, ActivationRun } from '../domain/activation.js';
import type { AdmissionReport } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';
import {
  buildRecallTrace,
  type RecallTrace,
  type RecallTraceObserver,
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
 * What the run read from and what it asked, as digests. The query text itself never reaches a
 * trace: a trace is written where a pack is not, and caller text is the one thing here that
 * carries whatever the caller happened to type.
 */
function identityDigests(
  config: Config,
  query: string,
): {
  readonly queryDigest: string;
  readonly configDigest: string;
  readonly providerDigest: string;
} {
  return {
    queryDigest: digest(query),
    configDigest: digest(JSON.stringify([config.recall, config.search, config.activation])),
    providerDigest: digest(JSON.stringify([config.models.cue, config.models.embed])),
  };
}

/** The vantage the whole run was bound to, as a code two traces can be compared on. */
function readModeCode(mode: ReadMode): string {
  if (mode.validAt !== undefined && mode.knownAt !== undefined) {
    return 'as_of+knew_at';
  }
  if (mode.validAt !== undefined) {
    return 'as_of';
  }
  if (mode.knownAt !== undefined) {
    return 'knew_at';
  }
  return 'default';
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
  readonly emitted: ReadonlySet<string>;
};

/** Builds the trace and hands it over, or does nothing at all when nobody is observing. */
export function emitRecallTrace(
  observer: RecallTraceObserver | undefined,
  config: Config,
  values: RecallStageValues,
): RecallTrace | undefined {
  if (observer === undefined) {
    return undefined;
  }
  const trace = buildRecallTrace({
    sessionId: values.sessionId,
    sampledAt: values.sampledAt.toISOString(),
    readMode: readModeCode(values.mode),
    ...identityDigests(config, values.query),
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
    emitted: values.emitted,
  });
  observer(trace);
  return trace;
}

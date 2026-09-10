import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

/**
 * What the driver's managed retry did on the write path, counted from callback invocations.
 *
 * `session.executeWrite` replays its callback when an attempt raises something the driver
 * treats as transient, then hands the caller the eventual outcome with nothing said about the
 * replay. A caller's success is therefore no evidence that its transaction did not deadlock,
 * and nothing else in the tree counts a replayed cycle. Invocations are the only honest
 * source: the driver checks its retry budget against elapsed time, so even a zero budget can
 * permit a replay and the configured budget says nothing about how many happened.
 *
 * Coverage is callback-specific, which is why every name here says `callback`. A begin or a
 * commit failure happens outside the callback, so it is seen only when a later invocation
 * follows it, and never on its own. The `executeQuery` write helpers beside
 * `inWriteTransaction` (`runWrite`, `writeFirst`, `runWriteWithCounters`) carry managed retry
 * with no callback at all, so their replays are not observed here. The explicit publication
 * transaction is not managed and takes no retry, so it has nothing to count.
 *
 * Observation never changes the operation it observes. Construction cannot fail the write:
 * a fault while starting an accumulation leaves the call unobserved and the write path exactly
 * as it would be with no observer at all. Counting runs behind a guard, a body's return value
 * and its error pass through untouched, and what a fault costs is stated rather than absorbed:
 * `observerFailures` counts the faults, and `countsComplete` goes false when a fault could have
 * kept a count from being established. A count that is not complete is never published as a
 * measured value.
 */

/**
 * What the previous attempt raised, as far as the callback could see it. `other_transient` is
 * only ever counted when a replay followed, which is the driver's own verdict that the error
 * was transient. `outside_callback` is a replay after a body that returned normally: the
 * failure was in begin or commit and the callback never saw it. `unknown` is a replay whose
 * cause could not be read, which is never attributed to the class before it.
 */
export const MANAGED_WRITE_REPLAY_CLASSES = [
  'deadlock',
  'other_transient',
  'outside_callback',
  'unknown',
] as const;

export type ManagedWriteReplayClass = (typeof MANAGED_WRITE_REPLAY_CLASSES)[number];

/** The code the server names a lock cycle with. */
const DEADLOCK_CODE = 'Neo.TransientError.Transaction.DeadlockDetected';

/** A failure carrying no code of its own, kept under one name rather than dropped. */
const UNNAMED_CODE = 'unnamed';

/** A failure whose code could not be read at all, which is a different fact from an absent one. */
const UNREADABLE_CODE = 'unreadable';

/** Distinct codes a summary names before it stops adding them, so an odd error cannot grow it. */
const CODE_CAP = 16;

/** The identity an accumulation carries when it could not be given one of its own. */
const UNIDENTIFIED_EPOCH = 'unidentified';

export type ManagedWriteObservations = {
  /**
   * Identifies this accumulation. Counts are cumulative for one driver in one process, so two
   * samples carrying different epochs describe different populations and must not be
   * subtracted from each other.
   */
  readonly epoch: string;
  /**
   * False when a fault could have kept a count below from being established, or when this
   * accumulation has no identity of its own. Read it first: the numbers are not exact values
   * while it is false, and the read path publishes them as unavailable rather than measured.
   */
  readonly countsComplete: boolean;
  /** Calls of the wrapper: one logical write, however many times its callback ran. */
  readonly logicalOperations: number;
  readonly callbackAttempts: number;
  /** Invocations after the first: the replays the driver performed. */
  readonly callbackReplays: number;
  readonly replaysByClass: Readonly<Record<ManagedWriteReplayClass, number>>;
  /** Bodies that raised. A raised body is not by itself a replay or an exhausted operation. */
  readonly callbackFailures: number;
  /** Native codes only: no query text, no parameters, no ids. Sums to `callbackFailures`. */
  readonly failuresByCode: Readonly<Record<string, number>>;
  readonly failureCodesTruncated: boolean;
  readonly callerFulfilments: number;
  readonly callerRejections: number;
  /** Faults the bookkeeping hit and swallowed, whether or not they cost a count. */
  readonly observerFailures: number;
};

type Accumulation = {
  readonly epoch: string;
  countsComplete: boolean;
  logicalOperations: number;
  callbackAttempts: number;
  callbackReplays: number;
  replaysByClass: Record<ManagedWriteReplayClass, number>;
  callbackFailures: number;
  failuresByCode: Map<string, number>;
  failureCodesTruncated: boolean;
  callerFulfilments: number;
  callerRejections: number;
  observerFailures: number;
};

/**
 * Kept against the driver rather than in one process-wide total, so a reading names the driver
 * it was counted over and a driver nobody holds any more takes its counts with it.
 */
const ACCUMULATIONS = new WeakMap<Driver, Accumulation>();

/**
 * A fresh accumulation, which is built even when it cannot be given an identity. An epoch that
 * could not be allocated leaves the counts unable to say which population they belong to, so
 * the accumulation is marked incomplete for its whole life rather than reporting numbers a
 * delta could subtract across two different drivers.
 */
function newAccumulation(): Accumulation {
  const zero: Accumulation = {
    epoch: UNIDENTIFIED_EPOCH,
    countsComplete: false,
    logicalOperations: 0,
    callbackAttempts: 0,
    callbackReplays: 0,
    replaysByClass: { deadlock: 0, other_transient: 0, outside_callback: 0, unknown: 0 },
    callbackFailures: 0,
    failuresByCode: new Map(),
    failureCodesTruncated: false,
    callerFulfilments: 0,
    callerRejections: 0,
    observerFailures: 0,
  };
  try {
    return { ...zero, epoch: randomUUID(), countsComplete: true };
  } catch {
    return { ...zero, observerFailures: 1 };
  }
}

/** Undefined when starting one failed, which leaves the caller unobserved rather than broken. */
function accumulationFor(driver: Driver): Accumulation | undefined {
  try {
    const held = ACCUMULATIONS.get(driver);
    if (held !== undefined) {
      return held;
    }
    const fresh = newAccumulation();
    ACCUMULATIONS.set(driver, fresh);
    return fresh;
  } catch {
    return undefined;
  }
}

/** An error object may answer a property read with a throw, so every caller guards this. */
function nativeCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return UNNAMED_CODE;
  }
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : UNNAMED_CODE;
}

/**
 * One call of a managed write, which is one logical operation however many times the driver
 * runs its callback. The caller wraps each invocation in `attempt` and reports the outcome it
 * finally received to `settled`, after its own cleanup has resolved.
 */
export class ManagedWriteCall {
  readonly #accumulation: Accumulation | undefined;

  /**
   * Invocations so far. This alone decides whether an invocation is a replay, so a fault while
   * inspecting a cause can never add or drop one.
   */
  #invocations = 0;

  /** What the next invocation would be a replay for. Rewritten on every outcome, never stale. */
  #continuing: ManagedWriteReplayClass = 'unknown';

  constructor(driver: Driver) {
    this.#accumulation = accumulationFor(driver);
    this.#count((acc) => {
      acc.logicalOperations += 1;
    });
  }

  /** Runs one callback invocation and hands back its result or its error, unchanged. */
  async attempt<T>(body: () => Promise<T>): Promise<T> {
    const replayOf = this.#invocations > 0 ? this.#continuing : undefined;
    this.#invocations += 1;
    this.#count((acc) => {
      acc.callbackAttempts += 1;
      if (replayOf !== undefined) {
        acc.callbackReplays += 1;
        acc.replaysByClass[replayOf] += 1;
      }
    });
    try {
      const answer = await body();
      this.#continuing = 'outside_callback';
      return answer;
    } catch (err) {
      this.#continuing = 'unknown';
      this.#recordFailure(err);
      throw err;
    }
  }

  /**
   * The outcome the caller of the managed write received, which is the outcome after the
   * wrapper's own cleanup has resolved rather than the transaction's own answer.
   */
  settled(outcome: 'fulfilled' | 'rejected'): void {
    this.#count((acc) => {
      if (outcome === 'fulfilled') {
        acc.callerFulfilments += 1;
      } else {
        acc.callerRejections += 1;
      }
    });
  }

  /** The cause is read first and separately: an unreadable one is named, never inherited. */
  #recordFailure(err: unknown): void {
    const code = this.#readCode(err);
    this.#count((acc) => {
      acc.callbackFailures += 1;
      this.#recordCode(acc, code ?? UNREADABLE_CODE);
    });
    if (code !== undefined) {
      this.#continuing = code === DEADLOCK_CODE ? 'deadlock' : 'other_transient';
    }
  }

  /** Undefined when the error would not answer, which costs the code and no count. */
  #readCode(err: unknown): string | undefined {
    try {
      return nativeCode(err);
    } catch {
      this.#fault(false);
      return undefined;
    }
  }

  #count(mutate: (acc: Accumulation) => void): void {
    const acc = this.#accumulation;
    if (acc === undefined) {
      return;
    }
    try {
      mutate(acc);
    } catch {
      this.#fault(true);
    }
  }

  /** `costly` says the fault may have dropped a count, which is what makes a reading unusable. */
  #fault(costly: boolean): void {
    const acc = this.#accumulation;
    if (acc === undefined) {
      return;
    }
    acc.observerFailures += 1;
    if (costly) {
      acc.countsComplete = false;
    }
  }

  #recordCode(acc: Accumulation, code: string): void {
    const held = acc.failuresByCode.get(code);
    if (held !== undefined) {
      acc.failuresByCode.set(code, held + 1);
      return;
    }
    if (acc.failuresByCode.size >= CODE_CAP) {
      acc.failureCodesTruncated = true;
      return;
    }
    acc.failuresByCode.set(code, 1);
  }
}

/**
 * A copy of what this driver has accumulated. A driver that has run no managed write reads as
 * a measured zero with its own epoch, which is a different fact from an unavailable reading.
 * A driver whose accumulation could not be started reads as incomplete rather than as a clean
 * zero, since the writes it ran were never counted.
 */
export function readManagedWriteObservations(driver: Driver): ManagedWriteObservations {
  const held = accumulationFor(driver);
  if (held === undefined) {
    return {
      epoch: UNIDENTIFIED_EPOCH,
      countsComplete: false,
      logicalOperations: 0,
      callbackAttempts: 0,
      callbackReplays: 0,
      replaysByClass: { deadlock: 0, other_transient: 0, outside_callback: 0, unknown: 0 },
      callbackFailures: 0,
      failuresByCode: {},
      failureCodesTruncated: false,
      callerFulfilments: 0,
      callerRejections: 0,
      observerFailures: 0,
    };
  }
  return {
    epoch: held.epoch,
    countsComplete: held.countsComplete,
    logicalOperations: held.logicalOperations,
    callbackAttempts: held.callbackAttempts,
    callbackReplays: held.callbackReplays,
    replaysByClass: { ...held.replaysByClass },
    callbackFailures: held.callbackFailures,
    failuresByCode: Object.fromEntries(held.failuresByCode),
    failureCodesTruncated: held.failureCodesTruncated,
    callerFulfilments: held.callerFulfilments,
    callerRejections: held.callerRejections,
    observerFailures: held.observerFailures,
  };
}

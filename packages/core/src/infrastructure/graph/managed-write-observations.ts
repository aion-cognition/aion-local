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
 * commit failure happens outside the callback, so a replay it caused is counted with its cause
 * unknown rather than guessed. The `executeQuery` write helpers beside `inWriteTransaction`
 * (`runWrite`, `writeFirst`, `runWriteWithCounters`) carry managed retry with no callback at
 * all, so their replays are not observed here. The explicit publication transaction is not
 * managed and takes no retry, so it has nothing to count.
 *
 * Nothing here can fail a graph operation. Every count runs behind a guard, a body's return
 * value and its error both pass through untouched, and bookkeeping that throws lands in
 * `observerFailures`, which marks every other count as a floor.
 */

/**
 * What the previous attempt raised, as far as the callback could see it. `other_transient` is
 * only ever counted when a replay followed, which is the driver's own verdict that the error
 * was transient. `outside_callback` is a replay after a body that returned normally: the
 * failure was in begin or commit and the callback never saw it.
 */
export const MANAGED_WRITE_REPLAY_CLASSES = [
  'deadlock',
  'other_transient',
  'outside_callback',
] as const;

export type ManagedWriteReplayClass = (typeof MANAGED_WRITE_REPLAY_CLASSES)[number];

/** The code the server names a lock cycle with. */
const DEADLOCK_CODE = 'Neo.TransientError.Transaction.DeadlockDetected';

/** A failure carrying no code of its own, kept under one name rather than dropped. */
const UNNAMED_CODE = 'unnamed';

/** Distinct codes a summary names before it stops adding them, so an odd error cannot grow it. */
const CODE_CAP = 16;

export type ManagedWriteObservations = {
  /**
   * Identifies this accumulation. Counts are cumulative for one driver in one process, so two
   * samples carrying different epochs describe different populations and must not be
   * subtracted from each other.
   */
  readonly epoch: string;
  /** Calls of the wrapper: one logical write, however many times its callback ran. */
  readonly logicalOperations: number;
  readonly callbackAttempts: number;
  /** Invocations after the first: the replays the driver performed. */
  readonly callbackReplays: number;
  readonly replaysByClass: Readonly<Record<ManagedWriteReplayClass, number>>;
  /** Bodies that raised. A raised body is not by itself a replay or an exhausted operation. */
  readonly callbackFailures: number;
  /** Native codes only: no query text, no parameters, no ids. */
  readonly failuresByCode: Readonly<Record<string, number>>;
  readonly failureCodesTruncated: boolean;
  readonly callerFulfilments: number;
  readonly callerRejections: number;
  /** Bookkeeping that threw and was swallowed. Every count above is a floor while this is not zero. */
  readonly observerFailures: number;
};

type Accumulation = {
  readonly epoch: string;
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

function accumulationFor(driver: Driver): Accumulation {
  const held = ACCUMULATIONS.get(driver);
  if (held !== undefined) {
    return held;
  }
  const fresh: Accumulation = {
    epoch: randomUUID(),
    logicalOperations: 0,
    callbackAttempts: 0,
    callbackReplays: 0,
    replaysByClass: { deadlock: 0, other_transient: 0, outside_callback: 0 },
    callbackFailures: 0,
    failuresByCode: new Map(),
    failureCodesTruncated: false,
    callerFulfilments: 0,
    callerRejections: 0,
    observerFailures: 0,
  };
  ACCUMULATIONS.set(driver, fresh);
  return fresh;
}

/** Read through a guard, since an error object may answer a property read with a throw. */
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
 * finally received to `settled`.
 */
export class ManagedWriteCall {
  readonly #accumulation: Accumulation;

  /** The class the next invocation would be a replay for, or undefined before the first one. */
  #continuing: ManagedWriteReplayClass | undefined;

  constructor(driver: Driver) {
    this.#accumulation = accumulationFor(driver);
    this.#count(() => {
      this.#accumulation.logicalOperations += 1;
    });
  }

  /** Runs one callback invocation and hands back its result or its error, unchanged. */
  async attempt<T>(body: () => Promise<T>): Promise<T> {
    const continuing = this.#continuing;
    this.#count(() => {
      this.#accumulation.callbackAttempts += 1;
      if (continuing !== undefined) {
        this.#accumulation.callbackReplays += 1;
        this.#accumulation.replaysByClass[continuing] += 1;
      }
    });
    try {
      const answer = await body();
      this.#continuing = 'outside_callback';
      return answer;
    } catch (err) {
      this.#count(() => {
        const code = nativeCode(err);
        this.#accumulation.callbackFailures += 1;
        this.#recordCode(code);
        this.#continuing = code === DEADLOCK_CODE ? 'deadlock' : 'other_transient';
      });
      throw err;
    }
  }

  /** The outcome the caller of the managed write received, after every replay the driver ran. */
  settled(outcome: 'fulfilled' | 'rejected'): void {
    this.#count(() => {
      if (outcome === 'fulfilled') {
        this.#accumulation.callerFulfilments += 1;
      } else {
        this.#accumulation.callerRejections += 1;
      }
    });
  }

  #count(mutate: () => void): void {
    try {
      mutate();
    } catch {
      this.#accumulation.observerFailures += 1;
    }
  }

  #recordCode(code: string): void {
    const held = this.#accumulation.failuresByCode.get(code);
    if (held !== undefined) {
      this.#accumulation.failuresByCode.set(code, held + 1);
      return;
    }
    if (this.#accumulation.failuresByCode.size >= CODE_CAP) {
      this.#accumulation.failureCodesTruncated = true;
      return;
    }
    this.#accumulation.failuresByCode.set(code, 1);
  }
}

/**
 * A copy of what this driver has accumulated. A driver that has run no managed write reads as
 * a measured zero with its own epoch, which is a different fact from an unavailable reading.
 */
export function readManagedWriteObservations(driver: Driver): ManagedWriteObservations {
  const held = accumulationFor(driver);
  return {
    epoch: held.epoch,
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

import {
  DEFAULT_REFLECTION_LANE,
  type ReflectionLane,
} from '../../infrastructure/sqlite/reflection-queue.js';

/**
 * Which lane an arriving episode is enqueued in.
 *
 * The explicit flag is primary: a client that says `lane: "bulk"` is taken at its word and
 * nothing here can promote it. Everything else defaults to interactive, and the arrival-rate
 * backstop is the only thing that demotes it: a second line of defence for a client that
 * floods without saying so, rather than asking for the bulk lane outright.
 *
 * The backstop is deliberately hard to trip and easy to escape: a session that stops pushing
 * is back in the interactive lane one window later, because the window slides and the counter
 * is the arrivals inside it, not a latch.
 */

export type LaneAssignerOptions = {
  /** How far back an arrival counts. Both thresholds are counts inside this window. */
  readonly arrivalWindowMs: number;
  /**
   * Arrivals from one session inside the window before that session is demoted. Generous on
   * purpose: a legitimate session-end flush of a long conversation is several episodes at
   * once, and demoting it would break the freshness pin for the caller it exists to serve.
   */
  readonly sessionArrivalMax: number;
  /** Arrivals across every session inside the window above which the substrate counts as hot. */
  readonly globalArrivalMax: number;
  /**
   * The per-session allowance while the substrate is hot. Without it the per-session counter
   * alone is defeated by breadth: the measured flood was eight fresh sessions, and enough
   * sessions each staying just under `sessionArrivalMax` reproduce the same backlog with
   * every counter reading green.
   */
  readonly hotSessionArrivalMax: number;
};

export type LaneDecision = {
  readonly lane: ReflectionLane;
  /** Why the lane is what it is, for the intake log. */
  readonly reason: 'requested' | 'default' | 'session-rate' | 'global-rate';
  readonly sessionArrivals: number;
  readonly globalArrivals: number;
};

export type LaneRequest = {
  readonly sessionId: string;
  /** The wire's optional `lane`, absent when the caller did not choose. */
  readonly requested?: ReflectionLane;
  readonly now?: Date;
};

/**
 * Per-process arrival counters. The long-lived service is the single writer of the queue,
 * so one instance sees every arrival; a CLI container claims jobs, it never enqueues them,
 * and has no counter to keep.
 *
 * Memory is bounded by the window, not by the flood: timestamps older than the window are
 * dropped from the front on every observation, and a session with nothing left in the window
 * loses its entry entirely. The measured worst case (~4,100 arrivals in ten minutes) holds a
 * few thousand numbers.
 */
export class LaneAssigner {
  readonly #options: LaneAssignerOptions;
  readonly #bySession = new Map<string, number[]>();
  #global: number[] = [];

  constructor(options: LaneAssignerOptions) {
    this.#options = options;
  }

  /** Arrivals still inside the window, across every session. Read by the intake log and tests. */
  get globalArrivals(): number {
    return this.#global.length;
  }

  /**
   * Records the arrival and decides its lane. Recording and deciding are one call because
   * they must see the same window: an episode counts toward the rate it is judged against,
   * so the very first arrival of a burst cannot be judged against an empty window and then
   * pad the count for the second.
   *
   * Only genuinely new work should be passed here. A re-pushed payload that resolves to an
   * episode already queued is not an arrival: counting it would let a retrying client demote
   * itself for repeating work the substrate already holds.
   */
  assign(request: LaneRequest): LaneDecision {
    const at = (request.now ?? new Date()).getTime();
    const cutoff = at - this.#options.arrivalWindowMs;

    this.#global = prune(this.#global, cutoff);
    this.#global.push(at);

    const session = prune(this.#bySession.get(request.sessionId) ?? [], cutoff);
    session.push(at);
    this.#bySession.set(request.sessionId, session);
    this.#forgetIdleSessions(cutoff);

    const sessionArrivals = session.length;
    const globalArrivals = this.#global.length;
    const counts = { sessionArrivals, globalArrivals };

    // Only the demotion is taken at face value. An explicit `interactive` is a preference,
    // not an exemption: honouring it would let any client defeat the backstop by asserting
    // the lane it wants on every push, which is the one input a flooding client would send.
    if (request.requested === 'bulk') {
      return { lane: 'bulk', reason: 'requested', ...counts };
    }
    if (sessionArrivals > this.#options.sessionArrivalMax) {
      return { lane: 'bulk', reason: 'session-rate', ...counts };
    }
    if (
      globalArrivals > this.#options.globalArrivalMax &&
      sessionArrivals > this.#options.hotSessionArrivalMax
    ) {
      return { lane: 'bulk', reason: 'global-rate', ...counts };
    }
    return { lane: DEFAULT_REFLECTION_LANE, reason: 'default', ...counts };
  }

  /**
   * Sessions with no arrival left in the window. Swept on every observation rather than on a
   * timer: the map is only ever read here, so an entry that outlives its window costs memory
   * and nothing else, and a timer would keep the process alive to reclaim it.
   */
  #forgetIdleSessions(cutoff: number): void {
    for (const [sessionId, arrivals] of this.#bySession) {
      const live = prune(arrivals, cutoff);
      if (live.length === 0) {
        this.#bySession.delete(sessionId);
        continue;
      }
      this.#bySession.set(sessionId, live);
    }
  }
}

/**
 * Timestamps are appended in order, so everything expired is a prefix. The array is returned
 * unchanged when nothing expired, which is the common case: copying the whole window on every
 * arrival is what would make the counter itself scale with the flood it is measuring.
 */
function prune(timestamps: number[], cutoff: number): number[] {
  let first = 0;
  while (first < timestamps.length && (timestamps[first] ?? 0) <= cutoff) {
    first += 1;
  }
  if (first === 0) {
    return timestamps;
  }
  return timestamps.slice(first);
}

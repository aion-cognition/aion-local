/** What the dispatcher needs to start work without re-reading the queue row it was told about. */
export type ReflectionJobSignal = {
  readonly jobId: string;
  readonly jobType: string;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly enqueuedAt: Date;
};

export type ReflectionJobListener = (signal: ReflectionJobSignal) => void | Promise<void>;

export type ReflectionDispatchOptions = {
  readonly onListenerError?: (error: unknown, signal: ReflectionJobSignal) => void;
};

/**
 * The seam intake pushes through and the reflection worker subscribes to. Dispatch is
 * event-driven rather than polled: the `reflection_queue` row is durability for a restart
 * or a crash, not something a loop watches. One instance per service process, constructed
 * alongside the queue it shadows.
 *
 * A listener never fails an intake. The experience is already durable in the graph and the
 * queue by the time `signal` runs, so a thrown or rejected listener is routed to
 * `onListenerError` and the remaining listeners still run: losing the signal costs the
 * startup drain a job, not the caller their write.
 */
export class ReflectionDispatch {
  readonly #listeners = new Set<ReflectionJobListener>();
  readonly #onListenerError: ReflectionDispatchOptions['onListenerError'];

  constructor(options: ReflectionDispatchOptions = {}) {
    this.#onListenerError = options.onListenerError;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** Returns the unsubscribe; calling it twice is a no-op. */
  subscribe(listener: ReflectionJobListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  signal(signal: ReflectionJobSignal): void {
    for (const listener of [...this.#listeners]) {
      try {
        const result = listener(signal);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.#report(error, signal);
          });
        }
      } catch (error) {
        this.#report(error, signal);
      }
    }
  }

  #report(error: unknown, signal: ReflectionJobSignal): void {
    if (this.#onListenerError !== undefined) {
      this.#onListenerError(error, signal);
    }
  }
}

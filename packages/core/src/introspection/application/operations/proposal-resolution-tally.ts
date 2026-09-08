import type { WithheldWork } from '../../../evidence/application/judgment.js';

/**
 * One run's counters, mutated through methods rather than field writes: the tally is threaded
 * by reference through the two resolvers below, and a plain object's fields being written from
 * outside the type that owns them is what `no-param-reassign` catches.
 */
export class ResolutionTally {
  #applied = 0;
  #dismissed = 0;
  #open = 0;
  readonly #owed: WithheldWork[] = [];

  get applied(): number {
    return this.#applied;
  }

  get dismissed(): number {
    return this.#dismissed;
  }

  /** Rows this run read and could not decide. Neither a verdict nor a failure of the run. */
  get open(): number {
    return this.#open;
  }

  get decided(): number {
    return this.#applied + this.#dismissed;
  }

  recordApplied(): void {
    this.#applied += 1;
  }

  recordDismissed(): void {
    this.#dismissed += 1;
  }

  /** What a row left open owes, kept whole rather than reduced to a log line. */
  get owed(): readonly WithheldWork[] {
    return this.#owed;
  }

  recordOpen(work?: WithheldWork): void {
    this.#open += 1;
    if (work !== undefined) {
      this.#owed.push(work);
    }
  }
}

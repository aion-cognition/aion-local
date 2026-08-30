/**
 * The supersession stage's per-run counters, split out once `supersession.ts` alone passed
 * the repo's line cap. Mutated through mutator methods rather than field writes: it is
 * threaded by reference through every private helper in that file, and a plain object's
 * fields being reassigned from outside the class that owns them is exactly what
 * `no-param-reassign` catches.
 */
export class RunTally {
  #superseded = 0;
  #proposed = 0;
  #proposedBySubject = 0;
  #judgments = 0;
  #judgeErrors = 0;
  #unanimous = 0;
  #vetoed = 0;
  #staleTargets = 0;

  get superseded(): number {
    return this.#superseded;
  }

  /** Affirmative judgments the second pass also affirmed. */
  get unanimous(): number {
    return this.#unanimous;
  }

  /** Affirmative judgments the second pass refused, on either check. */
  get vetoed(): number {
    return this.#vetoed;
  }

  /**
   * Unanimous judgments that closed nothing because a side had already lost currency. Counted
   * apart from both closures and reviews: it is neither, and folding it into either one is a
   * number that describes something that did not happen.
   */
  get staleTargets(): number {
    return this.#staleTargets;
  }

  get proposed(): number {
    return this.#proposed;
  }

  /** Of the proposals, how many came from a shared subject rather than the KNN widener. */
  get proposedBySubject(): number {
    return this.#proposedBySubject;
  }

  get judgments(): number {
    return this.#judgments;
  }

  get judgeErrors(): number {
    return this.#judgeErrors;
  }

  recordJudgment(): void {
    this.#judgments += 1;
  }

  recordJudgeError(): void {
    this.#judgeErrors += 1;
  }

  recordSupersession(): void {
    this.#superseded += 1;
  }

  recordUnanimous(): void {
    this.#unanimous += 1;
  }

  recordVeto(): void {
    this.#vetoed += 1;
  }

  recordStaleTarget(): void {
    this.#staleTargets += 1;
  }

  recordProposal(bySubject: boolean): void {
    this.#proposed += 1;
    if (bySubject) {
      this.#proposedBySubject += 1;
    }
  }
}

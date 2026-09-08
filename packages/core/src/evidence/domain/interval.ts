/**
 * The one place a recorded interval is judged against a pinned vantage.
 *
 * A temporal read asks whether a recorded relation held at the moment it names. There are only
 * three honest answers, and a boolean can carry two of them. A bound can prove the relation was
 * outside the moment; the recorded bounds can place it inside; or the bound the decision turns on
 * was never recorded, and the reader knows it cannot say. Folding that third answer into either of
 * the first two is how an unanswerable question comes back certified: as a relation that held, or
 * as an empty set the caller is entitled to trust.
 *
 * Each bound is judged on its own clock. World time asks what held then and is answered by the
 * recorded world start and end; knowledge time asks what the substrate stated then and is answered
 * by the recorded retraction and the version's own entry into the view. A bound compared against
 * the other axis reports a relation that ended in one timeline as absent from the other.
 *
 * The currency flag is a statement about now. An unpinned question is a question about now, so
 * there the flag is the whole answer; a pinned question cannot use it, because "closed" says that
 * the relation ended without saying when.
 */

/** What the selected version recorded about its own interval. Every field may be absent. */
export type IntervalProof = {
  /** Whether the records call the relation closed, which says nothing about when. */
  readonly closed: boolean;
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly txFrom?: string;
  readonly txUntil?: string;
};

/** Which clock a missing bound belongs to, so a gap names the axis it could not answer. */
export type IntervalAxis = 'world' | 'knowledge';

export type IntervalDecision =
  /** Every bound the pinned axes need is recorded, and they place the relation inside. */
  | { readonly status: 'visible' }
  /** A recorded bound proves the relation was outside the moment asked about. */
  | { readonly status: 'excluded' }
  /** The bound this decision turns on was never recorded. Neither answer is available. */
  | { readonly status: 'unknown'; readonly axis: IntervalAxis };

/** The vantage a read pinned, in either timeline or both. */
export type IntervalVantage = {
  readonly validAt?: Date;
  readonly knownAt?: Date;
};

function startsAfter(stamp: string | undefined, at: Date): boolean {
  return stamp !== undefined && Date.parse(stamp) > at.getTime();
}

function endedBy(stamp: string | undefined, at: Date): boolean {
  return stamp !== undefined && Date.parse(stamp) <= at.getTime();
}

/**
 * The pinned axis a closed relation cannot be placed on, if there is one.
 *
 * Each axis carries its own end and answers for itself. A relation whose world end is recorded
 * and whose retraction is not has been placed on one timeline and not the other, and the axis
 * with the end says nothing about the axis without it: a read that pinned both asked two
 * questions and can only answer one. World time is reported first where both are missing, so the
 * gap a caller sees is deterministic.
 */
function unplacedAxis(proof: IntervalProof, vantage: IntervalVantage): IntervalAxis | undefined {
  if (vantage.validAt !== undefined && proof.validUntil === undefined) {
    return 'world';
  }
  if (vantage.knownAt !== undefined && proof.txUntil === undefined) {
    return 'knowledge';
  }
  return undefined;
}

/**
 * The one evaluator every temporal read path shares.
 *
 * Exclusion is decided first: a recorded bound that puts the relation outside the moment settles
 * it, whatever else is missing, because a relation proved outside needs no second proof. Only then
 * is each pinned axis asked, on its own, whether a recorded close can be placed on it.
 */
export function evaluateInterval(proof: IntervalProof, vantage: IntervalVantage): IntervalDecision {
  const { validAt, knownAt } = vantage;
  if (validAt === undefined && knownAt === undefined) {
    return proof.closed ? { status: 'excluded' } : { status: 'visible' };
  }
  if (
    validAt !== undefined &&
    (startsAfter(proof.validFrom, validAt) || endedBy(proof.validUntil, validAt))
  ) {
    return { status: 'excluded' };
  }
  if (
    knownAt !== undefined &&
    (startsAfter(proof.txFrom, knownAt) || endedBy(proof.txUntil, knownAt))
  ) {
    return { status: 'excluded' };
  }
  const unplaced = proof.closed ? unplacedAxis(proof, vantage) : undefined;
  if (unplaced !== undefined) {
    // The records say this ended and never say when, on this clock. Withholding the row is right,
    // and calling the resulting set complete is not. An end on the other clock does not help: it
    // answers a question this axis did not ask.
    return { status: 'unknown', axis: unplaced };
  }
  return { status: 'visible' };
}

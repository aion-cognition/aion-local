import type { AdmissionRule, RecallMethod } from '@aion/protocol';

/**
 * Empty beats noisy, as an absolute rule rather than a rank one. What a retrieval leg
 * measured decides whether an item may reach a pack at all; where it ranks once admitted is
 * fusion's business.
 *
 * The floors are calibrated against the embedding model's own measured noise, both
 * distributions of it: unrelated text and genuine matches (`floors.fixtures.ts`,
 * `floor-calibration.int.test.ts`). A floor fitted to noise alone cannot tell "rejects
 * unrelated text" from "rejects everything".
 */

/**
 * One retrieval method's answer about one candidate, kept per method and per cue rather than
 * collapsed into a single number, because admission asks how many independent things found
 * this and a maximum cannot say.
 */
export type Measurement = {
  readonly method: RecallMethod;
  /** The method's own measurement on its own scale. Zero where the method measures nothing. */
  readonly relevance: number;
  /** Lucene matched the verbatim cue as a phrase, or the cue resolved an entity name exactly. */
  readonly exact?: true;
  /** The cue behind the hit; two cues finding the same node is what corroboration counts. */
  readonly cue?: string;
};

/** How BM25 evidence may admit an item. `any` is the pre-floor behaviour, kept as an escape hatch. */
export type Bm25AdmissionMode = 'exact' | 'corroborated' | 'any';

/**
 * Cosines are comparable across queries, so they get numbers; a Lucene score moves with the
 * corpus and the query, so the lexical leg gets a rule instead.
 */
export type AdmissionPolicy = {
  /** Cosine at or above which one measurement admits an item on its own. */
  readonly vectorFloor: number;
  /** Cosine at or above which a measurement counts as one unit of corroboration. */
  readonly corroborationFloor: number;
  readonly bm25Mode: Bm25AdmissionMode;
};

/** What the gate did, so a thin pack can say why it is thin rather than looking like an outage. */
export type AdmissionReport = {
  readonly policy: AdmissionPolicy;
  /** Distinct candidates the gate judged; contentless and structural rows never reach it. */
  readonly considered: number;
  readonly admitted: number;
  /** Measured by at least one method, and no measurement, exact hit or corroboration cleared. */
  readonly droppedBelowFloor: number;
  /**
   * Nothing measured it against the query, so no floor ever judged it: a node the spread
   * reached whose content vector is still pending, or a hit from a leg that measures
   * something other than relevance.
   */
  readonly droppedUnmeasured: number;
  /**
   * The subset of the above that no seed leg found at all: reached by spreading activation and
   * never scored against the query. The whole tally cannot say whether traversal is admitting
   * nothing, because ordinary recency and plain-BM25 seeds are the bulk of it; this can.
   */
  readonly droppedUnmeasuredArrival: number;
  readonly droppedDuplicateContent: number;
  /**
   * Admitted, but bumped from a near-identical cluster that already filled its cap. Near-duplicate
   * episodes can take up to 29.5% of a pack's slots. Distinct from `droppedDuplicateContent`,
   * which is exact text; this is the crowding cap.
   */
  readonly droppedNearDuplicate: number;
  /** At least one candidate cleared admission on its own evidence. */
  readonly anchored: boolean;
};

/**
 * The methods whose score is a cosine on [0,1], and so the only ones a floor can be measured
 * against. BM25 is absent by construction: a Lucene score is corpus-relative. Recency and
 * activation are absent because neither score measures how well a node answers the query: an
 * activation score measures how strongly the graph connects the node to a seed. A node the
 * spread reached is scored against the query separately (`arrival-scoring.ts`), and that
 * cosine reaches the gate as the vector measurement it is.
 */
const COSINE_METHODS: ReadonlySet<RecallMethod> = new Set<RecallMethod>([
  'vector',
  'entity_resolution',
  'resonance',
]);

/** Same method, same cue is the same evidence seen twice, whichever leg carried it here. */
function measurementKey(measurement: Measurement): string {
  return `${measurement.method} ${measurement.cue ?? ''}`;
}

/**
 * The rule that admitted an item, the measurements that qualified under it, and the score the
 * rule actually read. A pack prints all three, so the number beside an admitted item is one
 * the gate weighed rather than the best number anything happened to measure.
 */
export type AdmissionEvidence = {
  readonly rule: AdmissionRule;
  /**
   * The strongest cosine the rule counted, and zero when it counted none. Zero is not low
   * confidence, it is no measurement: a literal match carries no number and inventing one for
   * it would put it on a scale it was never on.
   */
  readonly score: number;
  /** Each qualifying measurement as the pack prints it: `vector 0.56`, `bm25 exact`. */
  readonly qualifying: readonly string[];
};

function describe(measurement: Measurement): string {
  if (measurement.exact === true) {
    return `${measurement.method} exact`;
  }
  return `${measurement.method} ${measurement.relevance.toFixed(2)}`;
}

/**
 * Three ways in, and a rank is not one of them:
 *
 *  - a cosine at or above the calibrated floor, which is one method vouching alone;
 *  - a literal match, Lucene on the verbatim cue or an exact entity name, which is evidence
 *    rather than a measurement, so no floor applies to it;
 *  - corroboration: two independent measurements, each at or above the lower corroboration
 *    floor, where independence is by method and by cue.
 *
 * A plain BM25 hit is none of them. Sharing one term with a cue at an uncalibrated score fills
 * result packs with unrelated content. Normalizing that score to the best hit of the same query
 * makes the top of every list read 1.00.
 *
 * The reach itself is none of them either, and no caller may make it one. A node the spread
 * reached is admitted on the cosine something measured for it, exactly as a seed is, and never
 * on the strength of the path that found it: an off-topic pack fills to budget the moment one
 * incidental hit is allowed to unlock everything activation touched.
 *
 * `undefined` is the refusal. The three rules are reported in the order above rather than in
 * the order the measurements arrive, so an item that cleared the vector floor is explained by
 * the floor it cleared even when a literal hit would also have let it in.
 */
export function admissionEvidence(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy,
): AdmissionEvidence | undefined {
  const corroborating = new Map<string, Measurement>();
  const cleared: Measurement[] = [];
  const literal: Measurement[] = [];
  let bm25Alone: Measurement | undefined;

  for (const measurement of measurements) {
    if (measurement.exact === true) {
      if (measurement.method !== 'bm25' || policy.bm25Mode !== 'corroborated') {
        literal.push(measurement);
      }
      corroborating.set(measurementKey(measurement), measurement);
      continue;
    }
    if (measurement.method === 'bm25') {
      if (policy.bm25Mode === 'any') {
        bm25Alone ??= measurement;
      }
      continue;
    }
    if (!COSINE_METHODS.has(measurement.method)) {
      continue;
    }
    if (measurement.relevance >= policy.vectorFloor) {
      cleared.push(measurement);
    }
    if (measurement.relevance >= policy.corroborationFloor) {
      corroborating.set(measurementKey(measurement), measurement);
    }
  }

  if (cleared.length > 0) {
    return {
      rule: 'vector_floor',
      score: absoluteRelevance(cleared),
      qualifying: cleared.map(describe),
    };
  }
  if (literal.length > 0) {
    return { rule: 'exact_match', score: 0, qualifying: literal.map(describe) };
  }
  if (corroborating.size >= 2) {
    const qualifying = [...corroborating.values()];
    return {
      rule: 'corroborated',
      score: absoluteRelevance(qualifying),
      qualifying: qualifying.map(describe),
    };
  }
  // The escape hatch: a plain lexical hit admits alone only where the operator asked for it.
  if (bm25Alone !== undefined) {
    return { rule: 'bm25_any', score: 0, qualifying: [describe(bm25Alone)] };
  }
  return undefined;
}

export function admitsOnEvidence(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy,
): boolean {
  return admissionEvidence(measurements, policy) !== undefined;
}

/**
 * Whether anything judged this item against the query at all, which is a different question
 * from whether it passed. A refusal is only readable when the two are counted apart: a
 * measurement that fell short says the floor is working, and no measurement at all says the
 * item was never given a chance to clear one.
 */
export function wasMeasured(measurements: readonly Measurement[]): boolean {
  for (const measurement of measurements) {
    if (measurement.exact === true || COSINE_METHODS.has(measurement.method)) {
      return true;
    }
  }
  return false;
}

/**
 * The strongest cosine in a set of measurements, and zero when none of them is one. A cosine is
 * the only number about an item that is comparable between queries, so it is the only one a
 * pack may print as a confidence. Applied to the measurements that qualified under the
 * admitting rule rather than to all of them: a leg that measured 0.53 and admitted nothing is
 * not what let the item in, and printing its number beside the item reads as a floor that
 * leaked.
 */
export function absoluteRelevance(measurements: readonly Measurement[]): number {
  let best = 0;
  for (const measurement of measurements) {
    if (!COSINE_METHODS.has(measurement.method)) {
      continue;
    }
    best = Math.max(best, measurement.relevance);
  }
  return best;
}

import type { AdmissionRule, RecallMethod } from '@aion/protocol';

/**
 * Empty beats noisy, as an absolute rule rather than a rank one. What a retrieval leg
 * measured decides whether an item may reach a pack at all; where it ranks once admitted is
 * fusion's business.
 *
 * The floors are calibrated against the embedding model's own measured noise, both
 * distributions of it: unrelated text and genuine matches (`floors.data.ts`,
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
 * The knowledge-bearing edge types the typed-admission tier reads. A partner that contradicts,
 * supersedes, or causally follows is evidence a cosine cannot see; CO_OCCURS and SIMILAR are
 * excluded on purpose, since their evidence is exactly what embedding already measures.
 */
export const TYPED_ADMISSION_EDGE_TYPES = ['CONTRADICTS', 'SUPERSEDES', 'CAUSES'] as const;

export type TypedAdmissionEdgeType = (typeof TYPED_ADMISSION_EDGE_TYPES)[number];

export function isTypedAdmissionEdgeType(type: string): type is TypedAdmissionEdgeType {
  return (TYPED_ADMISSION_EDGE_TYPES as readonly string[]).includes(type);
}

/**
 * The strongest single hop of typed evidence that reached an activation-only arrival: which of
 * the three qualifying types carried it, and the propagated contribution that one edge alone
 * delivered, isolated from whatever else the spread accumulated for the same node.
 */
export type TypedInboundEvidence = {
  readonly edgeType: TypedAdmissionEdgeType;
  readonly contribution: number;
};

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
  /**
   * The typed-admission tier's kill switch. Optional: a caller that never passes typed evidence
   * to `admissionEvidence` cannot reach the tier regardless, which is every test written before
   * it existed.
   */
  readonly typedAdmissionEnabled?: boolean;
  /**
   * The contribution one typed edge alone must carry, apart from whatever else the spread
   * accumulated for the node. Shipped at 0.14: at the default decay (0.7, no hub inhibition) a
   * full-strength seed's strongest single hop through CONTRADICTS or CAUSES (halved as
   * model-inferred) propagates 1 x 0.35 x 0.7 = 0.245, and through SUPERSEDES (halved again for
   * landing on superseded lineage) 1 x 0.4 x 0.7 x 0.5 = 0.14. That SUPERSEDES ceiling is the
   * lowest of the three, so it is the highest floor every qualifying type can still clear. One
   * ordinary hop before the typed edge still clears it (0.63 x 0.35 x 0.7 = 0.154, the "three
   * hops away" case the tier exists for); a second typed hop in the chain does not (0.245 x 0.35
   * x 0.7 = 0.06). `admission.test.ts` pins this arithmetic.
   */
  readonly typedAdmissionActivationFloor?: number;
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
  /**
   * Admitted on typed evidence rather than a vector floor: an activation-only arrival whose
   * strongest inbound CONTRADICTS, SUPERSEDES, or CAUSES edge cleared the tier's own activation
   * floor, at a cosine that cleared the lower corroboration floor instead of the higher vector
   * one. Counted apart so a thin pack can say the graph itself found something a cosine alone
   * would have refused.
   */
  readonly typedAdmitted: number;
};

/**
 * The methods whose score is a cosine on [0,1], and so the only ones a floor can be measured
 * against. BM25 is absent by construction: a Lucene score is corpus-relative. Recency and
 * activation are absent because neither score measures how well a node answers the query: an
 * activation score measures how strongly the graph connects the node to a seed. A node the
 * spread reached is scored against the query separately (`arrival-scoring.ts`), and that
 * cosine reaches the gate as the vector measurement it is.
 *
 * Resonance is absent for the same reason on a different axis: a resonance score is a cosine
 * in context space against a centroid, not against the query, and `vectorFloor` was calibrated
 * on cue-against-content readings. The resonance path keeps its own rule (`context_threshold`,
 * `resonance.ts`) and never asks this gate.
 */
const COSINE_METHODS: ReadonlySet<RecallMethod> = new Set<RecallMethod>([
  'vector',
  'entity_resolution',
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
 * Three ways in on measurement alone, and a rank is not one of them:
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
 * A fourth way in exists for an activation-only arrival carrying `typedEvidence`, and it is
 * narrower than the three above rather than an alternative to them: it only runs once none of
 * the three has admitted the item, and it still reads a cosine, just at the lower corroboration
 * floor instead of the vector one. What earns that discount is the strongest CONTRADICTS,
 * SUPERSEDES, or CAUSES edge that reached the node clearing its own activation floor, which is
 * evidence the query's own embedding cannot see: a contradicting or superseding node three hops
 * away that says nothing lexically or vectorially similar to the cue.
 *
 * `undefined` is the refusal. The rules are reported in the order above rather than in the
 * order the measurements arrive, so an item that cleared the vector floor is explained by the
 * floor it cleared even when a literal hit would also have let it in.
 */
export function admissionEvidence(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy,
  typedEvidence?: TypedInboundEvidence,
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

  // The narrow fourth door. It runs last and only for an arrival carrying typed evidence: the
  // knob is off, or nothing propagated a qualifying edge into this node, and it is exactly the
  // refusal above.
  if (
    policy.typedAdmissionEnabled === true &&
    typedEvidence !== undefined &&
    policy.typedAdmissionActivationFloor !== undefined &&
    typedEvidence.contribution >= policy.typedAdmissionActivationFloor
  ) {
    let strongestCosine: Measurement | undefined;
    for (const measurement of measurements) {
      if (!COSINE_METHODS.has(measurement.method)) {
        continue;
      }
      if (measurement.relevance < policy.corroborationFloor) {
        continue;
      }
      if (strongestCosine === undefined || measurement.relevance > strongestCosine.relevance) {
        strongestCosine = measurement;
      }
    }
    if (strongestCosine !== undefined) {
      return {
        rule: 'typed_admission',
        score: strongestCosine.relevance,
        qualifying: [`typed-edge: ${typedEvidence.edgeType}`, describe(strongestCosine)],
      };
    }
  }

  return undefined;
}

export function admitsOnEvidence(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy,
  typedEvidence?: TypedInboundEvidence,
): boolean {
  return admissionEvidence(measurements, policy, typedEvidence) !== undefined;
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

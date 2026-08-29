import type { RecallMethod } from '@aion/protocol';

/**
 * PRD §3.1's "empty beats noisy", as an absolute rule rather than a rank one. What a
 * retrieval leg measured decides whether an item may reach a pack at all; where it ranks
 * once admitted is fusion's business.
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
  /** Reached by traversal alone in a recall where nothing anchored the pack. */
  readonly droppedUnanchored: number;
  readonly droppedDuplicateContent: number;
  /** At least one item was admitted on its own evidence, which is what lets traversal extend it. */
  readonly anchored: boolean;
};

/**
 * The methods whose score is a cosine on [0,1], and so the only ones a floor can be measured
 * against. BM25 is absent by construction: a Lucene score is corpus-relative. Recency and
 * activation are absent because neither measures how well a node answers the query.
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
 * Three ways in, and a rank is not one of them:
 *
 *  - a cosine at or above the calibrated floor, which is one method vouching alone;
 *  - a literal match — Lucene on the verbatim cue, or an exact entity name — which is
 *    evidence rather than a measurement, so no floor applies to it;
 *  - corroboration: two independent measurements, each at or above the lower corroboration
 *    floor, where independence is by method and by cue.
 *
 * A plain BM25 hit is none of them. Sharing one term with a cue at an uncalibrated score is
 * what filled every off-topic pack in the exercise, and normalizing that score to the best
 * hit of the same query made the top of every list read 1.00.
 *
 * Traversal is judged by the caller: a node the spread reached has no measurement of its own
 * and extends a pack something else anchored.
 */
export function admitsOnEvidence(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy,
): boolean {
  const corroborating = new Set<string>();
  let alone = false;

  for (const measurement of measurements) {
    if (measurement.exact === true) {
      if (measurement.method !== 'bm25' || policy.bm25Mode !== 'corroborated') {
        alone = true;
      }
      corroborating.add(measurementKey(measurement));
      continue;
    }
    if (measurement.method === 'bm25') {
      if (policy.bm25Mode === 'any') {
        alone = true;
      }
      continue;
    }
    if (!COSINE_METHODS.has(measurement.method)) {
      continue;
    }
    if (measurement.relevance >= policy.vectorFloor) {
      alone = true;
    }
    if (measurement.relevance >= policy.corroborationFloor) {
      corroborating.add(measurementKey(measurement));
    }
  }

  return alone || corroborating.size >= 2;
}

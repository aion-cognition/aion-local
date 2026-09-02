import { foldName } from './name-fold.js';

/**
 * The name-form half of entity identity. Vector proximity alone is wrong in both directions:
 * `gitlab-token` scores 0.9109 against `github-token` and merges two different credentials,
 * while the embedding model returns one constant vector for whole classes of out-of-vocabulary
 * text, so eight distinct emoji entities collapse into one. A merge needs a second,
 * independent piece of evidence about the names themselves.
 *
 * This is string-similarity math over folded names, not text heuristics: nothing is tokenized
 * against a vocabulary, stemmed, or matched to a keyword list. The cognitive judgments (what
 * the entity is, what type it has) stay with the model.
 */

/**
 * Set overlap over character bigrams, divided by the smaller side (Szymkiewicz-Simpson) rather
 * than by both sides (Dice). Dividing by the smaller side is what lets a short form match the
 * long name that contains it (`aion` against `aion project`, `chen` against `sarah chen`,
 * `postgres` against `postgresql` all reach 1.0), which is the commonest real duplicate shape
 * and the one Dice scores lowest. Two names that merely resemble each other stay well under:
 * `redis`/`redix` measures 0.75 and `github-token`/`gitlab-token` measures 0.727.
 */
export const NAME_FORM_OVERLAP_THRESHOLD = 0.85;

/**
 * Below this many characters the overlap rule degenerates: a two-bigram name is contained in
 * any longer name that happens to spell it, so `api` would match `rapid` at 1.0. Short names
 * have to fold equal instead.
 */
export const MIN_OVERLAP_NAME_LENGTH = 4;

function characterBigrams(value: string): ReadonlySet<string> {
  const characters = Array.from(value);
  const grams = new Set<string>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    grams.add(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`);
  }
  return grams;
}

/** Both arguments must already be folded. Zero when either side is too short to have a bigram. */
export function nameFormOverlap(foldedA: string, foldedB: string): number {
  const gramsA = characterBigrams(foldedA);
  const gramsB = characterBigrams(foldedB);
  const smaller = gramsA.size <= gramsB.size ? gramsA : gramsB;
  const larger = smaller === gramsA ? gramsB : gramsA;
  if (smaller.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) {
      shared += 1;
    }
  }
  return shared / smaller.size;
}

/**
 * Digits are how one kind of thing names its instances, and character overlap cannot see the
 * difference: `beta episode 1` against `beta episode 2` overlaps at 0.923 and the two are
 * different episodes. Four of the measured false merges are exactly this shape. Compared as a
 * sorted set rather than by position, so where a digit sits in the name does not decide the
 * answer.
 */
function digitRuns(folded: string): string[] {
  return (folded.match(/\d+/g) ?? []).sort();
}

export function nameDigitsMatch(foldedA: string, foldedB: string): boolean {
  const runsA = digitRuns(foldedA);
  const runsB = digitRuns(foldedB);
  return runsA.length === runsB.length && runsA.every((run, index) => run === runsB[index]);
}

/**
 * The sanity check a merge candidate has to clear on top of vector proximity: the two names
 * fold to the same string, or they carry the same digits and overlap past
 * `NAME_FORM_OVERLAP_THRESHOLD`. Description prose cannot merge two identities on its own,
 * and neither can a degenerate embedding: two names that share no characters score 0
 * whatever their vectors say.
 */
export function nameFormMatches(a: string, b: string): boolean {
  const foldedA = foldName(a);
  const foldedB = foldName(b);
  if (foldedA.length === 0 || foldedB.length === 0) {
    return false;
  }
  if (foldedA === foldedB) {
    return true;
  }
  if (!nameDigitsMatch(foldedA, foldedB)) {
    return false;
  }
  if (Math.min(Array.from(foldedA).length, Array.from(foldedB).length) < MIN_OVERLAP_NAME_LENGTH) {
    return false;
  }
  return nameFormOverlap(foldedA, foldedB) >= NAME_FORM_OVERLAP_THRESHOLD;
}

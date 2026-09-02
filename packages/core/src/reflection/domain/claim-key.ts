import { foldName } from './name-fold.js';

/**
 * A claim key is the pair (subject entity, aspect) a fact-bearing claim asserts about: the
 * subject is a resolved entity id, the aspect is the attribute being asserted, folded. Two
 * claims carrying one key state the same attribute of the same thing, so the later one
 * corrects the earlier without a model deciding anything.
 *
 * The aspect names the attribute and never its value: `supersede mode`, not `unanimous`. A
 * key over the value keys every distinct answer to a different slot and closes nothing.
 */

/**
 * The resolved entity a claim asserts about, as the node stores it. It sits here rather than
 * beside the keyed close because two graph modules read it and one of them imports the other:
 * the family close compares the key, the keyed close writes it.
 */
export const CLAIM_SUBJECT_PROPERTY = 'subject_entity_id';

/** The folded attribute name, which is what makes two claims about one subject comparable. */
export const CLAIM_ASPECT_PROPERTY = 'aspect_norm';

/**
 * How long a claim answers for. `reading` is a measurement of something that moves and goes
 * stale on a clock; `standing` holds until something corrects it; `trend` names a direction,
 * and a direction has no expiry date. Only `reading` takes a horizon.
 */
export const TEMPORAL_CLASSES = ['reading', 'standing', 'trend'] as const;

export type TemporalClass = (typeof TEMPORAL_CLASSES)[number];

/**
 * Narrows what a provider returned. A model that invents a fourth class costs the claim its
 * key here rather than costing the claim: an unrecognized class is declined, never coerced to
 * one of the three.
 */
export function isTemporalClass(value: unknown): value is TemporalClass {
  return typeof value === 'string' && (TEMPORAL_CLASSES as readonly string[]).includes(value);
}

/**
 * A fold longer than this is a sentence rather than an attribute name, and a sentence keys
 * against nothing but itself. The key is declined at that point.
 */
export const MAX_ASPECT_LENGTH = 64;

/**
 * The aspect slug both sides of a key comparison are matched on. It runs through `foldName`,
 * the identity fold behind `name_norm`, because an aspect is an identity key: two spellings of
 * one attribute have to reach the same slug or the correction never finds the claim it
 * corrects. `normalizeCognitiveText` is the wrong fold here, since it skips NFKC and case
 * folding.
 *
 * Undefined is a normal answer. An aspect that folds to nothing, or to something too long to
 * be an attribute name, declines the key; the claim itself still lands and its correction
 * falls to the judge.
 */
export function foldAspect(aspect: string): string | undefined {
  const folded = foldName(aspect);
  if (folded.length === 0 || folded.length > MAX_ASPECT_LENGTH) {
    return undefined;
  }
  return folded;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * When a reading stops answering, in world time: forward from the episode's own clock, so a
 * replayed episode gets the horizon its experience earned rather than one dated to the replay.
 * The wall clock is never read here, and the answer is the same however often it is asked.
 */
export function readingHorizon(occurredAt: Date, days: number): Date {
  return new Date(occurredAt.getTime() + days * MILLISECONDS_PER_DAY);
}

/** Appendix B provenance: the close came from the key, with no judgment in it. */
export const KEYED_CLOSE_METHOD = 'keyed_close';

/** The evidence the close was made on, which is the key and nothing else. */
export const KEYED_CLOSE_SIGNALS: readonly string[] = ['subject_key'];

/**
 * What a keyed match does. `off` skips the lookup outright. `judge` records the key on the node
 * and leaves the pair to the two-pass judge, which is the shipped default. `close` is the
 * mechanical close the keyed path performs.
 *
 * It sits here for the reason the two property names do: the keyed close reads the mode to
 * decide whether it runs at all, the family close reads it to decide what a key is worth, and
 * one of those two modules imports the other.
 */
export type KeyedCloseMode = 'off' | 'judge' | 'close';

/**
 * Whether two different aspect slugs are evidence that two claims assert different attributes.
 * Only under `close`, the mode a deployment arms once its slugs measure reliable.
 *
 * Extraction keys both halves of a correction rarely, and the slug drifts between observations:
 * "checkpoint state storage location" against "checkpoint state storage backend" is one
 * attribute named twice. A mismatch that excluded a sibling on that evidence holds a stale
 * claim open as current, so under every other mode a mismatch falls back to the containment
 * test and the relatedness floor. An exact match still confirms membership under every mode,
 * because a match is not a guess.
 */
export function keyedMismatchExcludes(mode: KeyedCloseMode | undefined): boolean {
  return mode === 'close';
}

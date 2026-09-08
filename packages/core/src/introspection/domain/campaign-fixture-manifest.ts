import type { ObservedArtifact } from './campaign-artifacts.js';

/**
 * What a packaged fixture has to state about itself.
 *
 * A fixture built from a live capture carries two risks. It can drift from what was observed,
 * and it can quietly stand in for evidence nobody actually has. The manifest closes both: every
 * variant lists the changes it makes to the observed state, and every field the capture could
 * not recover is named as unknown rather than filled with something plausible.
 */

export const FIXTURE_VARIANTS = [
  /** The observed nodes, rows, references and closures, wrong semantics included. */
  'incident-snapshot',
  /**
   * The captured sources and claims as they stood before the first recorded closure. It tests
   * prevention, and it is not the unrecorded request the live run actually made.
   */
  'isolated-before-judgment',
] as const;

export type FixtureVariant = (typeof FIXTURE_VARIANTS)[number];

/** One deliberate difference between a variant and the observed capture. */
export type VariantDelta = {
  readonly kind: 'excluded_edge' | 'excluded_stamp' | 'excluded_proposal' | 'excluded_node';
  readonly subject: string;
  readonly reason: string;
};

/**
 * A field the capture does not hold. Recorded rather than defaulted: a temporal field filled
 * with a plausible clock is indistinguishable from one that was measured, and every comparison
 * made against it afterwards is unfounded.
 */
export type UnknownField = {
  readonly subject: string;
  readonly field: string;
};

export type FixtureManifest = {
  readonly variant: FixtureVariant;
  readonly manifestVersion: number;
  /** What this fixture is evidence of, in words, so a reader is not left inferring it. */
  readonly classification: string;
  /** The commit the capture was taken against, when the capture recorded one. */
  readonly capturedBuild?: string;
  readonly capturedAt: string;
  /** The verified artifacts the fixture was derived from, with the digests it was checked at. */
  readonly sourceArtifacts: readonly ObservedArtifact[];
  readonly deltas: readonly VariantDelta[];
  readonly unknownFields: readonly UnknownField[];
  /** Original identities, kept exactly: a fixture that renames them tests a different graph. */
  readonly originalIds: Readonly<Record<string, string>>;
  readonly expectedAssertions: readonly string[];
};

/**
 * Whether the manifest states enough for a reader to trust the fixture: it names its variant,
 * cites at least one verified artifact, and a variant that differs from the observed capture
 * says how.
 */
export function manifestIsComplete(manifest: FixtureManifest): boolean {
  if (manifest.sourceArtifacts.length === 0) {
    return false;
  }
  if (manifest.classification.trim().length === 0) {
    return false;
  }
  return manifest.variant === 'incident-snapshot' || manifest.deltas.length > 0;
}

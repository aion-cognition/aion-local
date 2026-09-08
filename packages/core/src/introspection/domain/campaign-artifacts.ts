/**
 * Digest verification for the preserved incident capture. The captured files are the only
 * record of what the substrate did, and a fixture derived from bytes nobody checked measures
 * whatever the bytes happen to be now. So verification runs first and its failure is a typed
 * outcome that names the artifact: packaging stops there rather than deriving a variant from
 * material that no longer matches what was captured.
 *
 * Pure comparison. Reading the files and hashing them belongs to the caller, which is what
 * lets the rule be exercised without a durable copy on disk.
 */

/** One line of a coreutils-style checksum manifest: a lowercase sha256 and the file it covers. */
export type ArtifactDigest = {
  readonly name: string;
  readonly sha256: string;
};

/** What the caller actually found on disk for one manifest entry. */
export type ObservedArtifact = {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
};

export const PACKAGING_FAILURE_REASONS = [
  'manifest_unreadable',
  'artifact_missing',
  'digest_mismatch',
] as const;

export type PackagingFailureReason = (typeof PACKAGING_FAILURE_REASONS)[number];

export type PackagingOutcome =
  | {
      readonly status: 'verified';
      /** In manifest order, so a report reads the same way twice. */
      readonly artifacts: readonly ObservedArtifact[];
      readonly totalBytes: number;
    }
  | {
      readonly status: 'failed';
      readonly reason: PackagingFailureReason;
      /** The manifest line that stopped packaging, or the manifest itself when it will not parse. */
      readonly artifact: string;
      readonly detail: string;
    };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Splits on the first run of whitespace so a name containing spaces survives. A leading `*`
 * marks binary mode in the coreutils format and is not part of the name.
 */
function parseLine(line: string): ArtifactDigest | undefined {
  const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
  if (match === null) {
    return undefined;
  }
  const [, digest, name] = match;
  if (digest === undefined || name === undefined) {
    return undefined;
  }
  return { name: name.trim(), sha256: digest.toLowerCase() };
}

/**
 * Every non-blank line has to parse. A manifest with one unreadable line is a manifest whose
 * coverage is unknown, and treating the readable lines as the whole set would verify a subset
 * while reporting the whole.
 */
export function parseChecksumManifest(text: string): readonly ArtifactDigest[] | undefined {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  const digests: ArtifactDigest[] = [];
  for (const line of lines) {
    const digest = parseLine(line);
    if (digest === undefined) {
      return undefined;
    }
    digests.push(digest);
  }
  return digests;
}

/**
 * Verifies observed bytes against the manifest, in manifest order, and stops at the first
 * artifact that fails. Extra observed files are not an error: the manifest states what the
 * capture covers, and a directory can hold notes beside it.
 */
export function verifyPreservedArtifacts(
  manifestText: string,
  observed: readonly ObservedArtifact[],
): PackagingOutcome {
  const expected = parseChecksumManifest(manifestText);
  if (expected === undefined) {
    return {
      status: 'failed',
      reason: 'manifest_unreadable',
      artifact: 'SHA256SUMS',
      detail: 'no line of the manifest parses as a sha256 and a file name',
    };
  }

  const byName = new Map(observed.map((artifact) => [artifact.name, artifact]));
  const verified: ObservedArtifact[] = [];
  for (const entry of expected) {
    const found = byName.get(entry.name);
    if (found === undefined) {
      return {
        status: 'failed',
        reason: 'artifact_missing',
        artifact: entry.name,
        detail: 'the manifest names it and the capture does not hold it',
      };
    }
    if (found.sha256.toLowerCase() !== entry.sha256 || !SHA256_PATTERN.test(entry.sha256)) {
      return {
        status: 'failed',
        reason: 'digest_mismatch',
        artifact: entry.name,
        detail: `manifest ${entry.sha256}, observed ${found.sha256.toLowerCase()}`,
      };
    }
    verified.push({ ...found, sha256: found.sha256.toLowerCase() });
  }

  return {
    status: 'verified',
    artifacts: verified,
    totalBytes: verified.reduce((total, artifact) => total + artifact.bytes, 0),
  };
}

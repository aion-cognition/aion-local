import { describe, expect, it } from 'vitest';

import {
  parseChecksumManifest,
  verifyPreservedArtifacts,
  type ObservedArtifact,
} from './campaign-artifacts.js';

const ALPHA = 'a'.repeat(64);
const BETA = 'b'.repeat(64);

const MANIFEST = `${ALPHA}  targets.json\n${BETA}  provenance.json\n`;

function observed(overrides: Partial<ObservedArtifact> = {}): ObservedArtifact {
  return { name: 'targets.json', sha256: ALPHA, bytes: 10, ...overrides };
}

describe('parsing a checksum manifest', () => {
  it('reads a digest and a name from each line', () => {
    expect(parseChecksumManifest(MANIFEST)).toEqual([
      { name: 'targets.json', sha256: ALPHA },
      { name: 'provenance.json', sha256: BETA },
    ]);
  });

  it('accepts the binary-mode marker and a name with a space', () => {
    expect(parseChecksumManifest(`${ALPHA} *round 9 trace.md`)).toEqual([
      { name: 'round 9 trace.md', sha256: ALPHA },
    ]);
  });

  it('rejects the whole manifest when one line does not parse', () => {
    expect(parseChecksumManifest(`${ALPHA}  targets.json\nnot-a-digest provenance.json`)).toBe(
      undefined,
    );
  });

  it('rejects an empty manifest', () => {
    expect(parseChecksumManifest('   \n\n')).toBe(undefined);
  });
});

describe('verifying preserved artifacts', () => {
  it('reports the covered artifacts and their total size when every digest matches', () => {
    const outcome = verifyPreservedArtifacts(MANIFEST, [
      observed({ name: 'provenance.json', sha256: BETA, bytes: 32 }),
      observed(),
    ]);
    expect(outcome).toEqual({
      status: 'verified',
      artifacts: [
        { name: 'targets.json', sha256: ALPHA, bytes: 10 },
        { name: 'provenance.json', sha256: BETA, bytes: 32 },
      ],
      totalBytes: 42,
    });
  });

  it('names the artifact the capture does not hold', () => {
    const outcome = verifyPreservedArtifacts(MANIFEST, [observed()]);
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'artifact_missing',
      artifact: 'provenance.json',
    });
  });

  it('names the artifact whose bytes changed', () => {
    const outcome = verifyPreservedArtifacts(MANIFEST, [
      observed({ sha256: 'c'.repeat(64) }),
      observed({ name: 'provenance.json', sha256: BETA }),
    ]);
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'digest_mismatch',
      artifact: 'targets.json',
    });
  });

  it('fails on an unreadable manifest before it looks at any artifact', () => {
    expect(verifyPreservedArtifacts('garbage', [observed()])).toMatchObject({
      status: 'failed',
      reason: 'manifest_unreadable',
      artifact: 'SHA256SUMS',
    });
  });

  it('ignores a file the manifest does not name', () => {
    const outcome = verifyPreservedArtifacts(MANIFEST, [
      observed(),
      observed({ name: 'provenance.json', sha256: BETA }),
      observed({ name: 'notes.md', sha256: 'd'.repeat(64) }),
    ]);
    expect(outcome.status).toBe('verified');
  });

  it('matches a digest written in upper case', () => {
    const outcome = verifyPreservedArtifacts(`${ALPHA.toUpperCase()}  targets.json`, [observed()]);
    expect(outcome.status).toBe('verified');
  });
});

describe('covering what the caller is going to read', () => {
  it('refuses a manifest that leaves a required artifact out', () => {
    const outcome = verifyPreservedArtifacts(
      MANIFEST,
      [observed()],
      ['targets.json', 'round-9.json'],
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'required_artifact_unlisted',
      artifact: 'round-9.json',
    });
  });

  it('refuses a manifest that names one artifact twice', () => {
    const outcome = verifyPreservedArtifacts(`${ALPHA}  targets.json\n${BETA}  targets.json`, [
      observed(),
    ]);
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'duplicate_manifest_entry',
      artifact: 'targets.json',
    });
  });

  it('verifies when every required artifact is covered', () => {
    const outcome = verifyPreservedArtifacts(
      MANIFEST,
      [observed(), observed({ name: 'provenance.json', sha256: BETA })],
      ['targets.json', 'provenance.json'],
    );
    expect(outcome.status).toBe('verified');
  });
});

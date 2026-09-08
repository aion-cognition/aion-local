import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  verifyPreservedArtifacts,
  type ObservedArtifact,
  type PackagingOutcome,
} from '../../../introspection/domain/campaign-artifacts.js';
import type {
  FixtureManifest,
  FixtureVariant,
  UnknownField,
  VariantDelta,
} from '../../../introspection/domain/campaign-fixture-manifest.js';

/**
 * Loads the preserved capture of a false supersession and packages it as two named fixtures.
 *
 * Verification runs first, every time. A fixture derived from bytes nobody checked measures
 * whatever the bytes happen to be, so a missing file or a changed digest returns a typed
 * failure and nothing downstream is built.
 *
 * The capture lives outside the repository and its location is named by the environment, not
 * by a path written here: the bytes are a record of one substrate at one moment, and a path
 * baked into the source would be wrong on every other machine.
 */

export const INCIDENT_DIR_ENV = 'AION_CAMPAIGN_INCIDENT_DIR';

const MANIFEST_FILE = 'SHA256SUMS';

/** Loading failures a caller can tell apart, over and above the packaging failures. */
export type IncidentLoadOutcome =
  | { readonly status: 'loaded'; readonly capture: IncidentCapture }
  | { readonly status: 'not_configured'; readonly detail: string }
  | { readonly status: 'unreadable'; readonly artifact: string; readonly detail: string }
  | (PackagingOutcome & { readonly status: 'failed' });

export type CapturedClaim = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly text: string;
  readonly occurredAt: string | null;
  readonly txFrom: string | null;
  readonly txUntil: string | null;
  readonly validUntil: string | null;
  readonly forgottenAt: string | null;
};

export type CapturedSource = {
  readonly claimId: string;
  readonly episodeId: string;
  readonly sessionId: string;
  readonly text: string;
};

export type CapturedLineageEdge = {
  readonly successorId: string;
  readonly predecessorId: string;
  readonly createdAt: string | null;
  readonly validUntil: string | null;
  readonly txUntil: string | null;
  readonly provenance: readonly string[];
};

export type CapturedArchiveRow = {
  readonly id: string;
  readonly identity: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly occurredAt: string;
  readonly archivedAt: string;
  readonly payloadBytes: number;
};

export type CapturedProposal = {
  readonly id: string;
  readonly oldId: string;
  readonly newId: string;
  readonly createdAt: string | null;
  readonly resolvedAt: string | null;
};

export type IncidentCapture = {
  readonly observedAt: string;
  readonly artifacts: readonly ObservedArtifact[];
  readonly recallEventId: number | null;
  readonly retrieved: readonly string[];
  readonly emitted: readonly string[];
  readonly claims: readonly CapturedClaim[];
  readonly sources: readonly CapturedSource[];
  readonly lineage: readonly CapturedLineageEdge[];
  readonly archive: readonly CapturedArchiveRow[];
  readonly proposals: readonly CapturedProposal[];
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readClaims(value: unknown): readonly CapturedClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry: Record<string, unknown>) => ({
    id: asString(entry.id),
    labels: asStringList(entry.labels),
    text: asString(entry.text),
    occurredAt: asNullableString(entry.occurredAt),
    txFrom: asNullableString(entry.txFrom),
    txUntil: asNullableString(entry.txUntil),
    validUntil: asNullableString(entry.validUntil),
    forgottenAt: asNullableString(entry.forgottenAt),
  }));
}

function readSources(value: unknown): readonly CapturedSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry: Record<string, unknown>) => ({
    claimId: asString(entry.claimId),
    episodeId: asString(entry.episodeId),
    sessionId: asString(entry.sessionId),
    text: asString(entry.text),
  }));
}

function readLineage(value: unknown): readonly CapturedLineageEdge[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry: Record<string, unknown>) => ({
    successorId: asString(entry.successorId),
    predecessorId: asString(entry.predecessorId),
    createdAt: asNullableString(entry.createdAt),
    validUntil: asNullableString(entry.validUntil),
    txUntil: asNullableString(entry.txUntil),
    provenance: asStringList(entry.provenance),
  }));
}

function readArchive(value: unknown): readonly CapturedArchiveRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry: Record<string, unknown>) => ({
    id: asString(entry.id),
    identity: asString(entry.identity),
    sessionId: asString(entry.session_id),
    episodeId: asString(entry.episode_id),
    occurredAt: asString(entry.occurred_at),
    archivedAt: asString(entry.archived_at),
    // The stored payload's size rather than the payload: a fixture that copies raw text out of
    // a capture into the repository publishes it a second time.
    payloadBytes: Buffer.byteLength(asString(entry.payload_json), 'utf8'),
  }));
}

function readProposals(value: unknown): readonly CapturedProposal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry: Record<string, unknown>) => ({
    id: asString(entry.id),
    oldId: asString(entry.old_id),
    newId: asString(entry.new_id),
    createdAt: asNullableString(entry.created_at),
    resolvedAt: asNullableString(entry.resolved_at),
  }));
}

function observeArtifacts(dir: string, names: readonly string[]): readonly ObservedArtifact[] {
  const observed: ObservedArtifact[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const bytes = readFileSync(path);
      observed.push({ name, sha256: sha256(bytes), bytes: statSync(path).size });
    } catch {
      // Left out of the observed set on purpose: the manifest comparison is what reports it
      // missing, and it reports it by name.
    }
  }
  return observed;
}

/**
 * Verifies the capture and decodes it, or says why it could not. The environment variable is
 * absent on an ordinary run, and that is a first-class outcome rather than a failure: nothing
 * in the pipeline needs the capture, only a comparison run does.
 */
export function loadIncidentCapture(dir = process.env[INCIDENT_DIR_ENV]): IncidentLoadOutcome {
  if (dir === undefined || dir.trim().length === 0) {
    return {
      status: 'not_configured',
      detail: `${INCIDENT_DIR_ENV} names no directory holding the preserved capture`,
    };
  }

  let manifestText: string;
  try {
    manifestText = readFileSync(join(dir, MANIFEST_FILE), 'utf8');
  } catch (err) {
    return { status: 'unreadable', artifact: MANIFEST_FILE, detail: String(err) };
  }

  const names = manifestText
    .split('\n')
    .map((line) => /^[0-9a-fA-F]{64}\s+\*?(.+)$/.exec(line.trim())?.[1]?.trim())
    .filter((name): name is string => name !== undefined);

  const outcome = verifyPreservedArtifacts(manifestText, observeArtifacts(dir, names));
  if (outcome.status === 'failed') {
    return outcome;
  }

  let targets: Record<string, unknown>;
  let provenance: Record<string, unknown>;
  try {
    targets = JSON.parse(readFileSync(join(dir, 'targets.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (err) {
    return { status: 'unreadable', artifact: 'targets.json', detail: String(err) };
  }

  const event = (targets.event ?? {}) as Record<string, unknown>;
  return {
    status: 'loaded',
    capture: {
      observedAt: asString(targets.observedAt),
      artifacts: outcome.artifacts,
      recallEventId: typeof event.id === 'number' ? event.id : null,
      retrieved: asStringList(event.retrieved),
      emitted: asStringList(event.ids),
      claims: readClaims(targets.targets),
      sources: readSources(targets.sources),
      lineage: readLineage(targets.lineage),
      archive: readArchive(targets.archive),
      proposals: readProposals(provenance.proposals),
    },
  };
}

export type IncidentFixture = {
  readonly manifest: FixtureManifest;
  readonly claims: readonly CapturedClaim[];
  readonly sources: readonly CapturedSource[];
  readonly lineage: readonly CapturedLineageEdge[];
  readonly archive: readonly CapturedArchiveRow[];
  readonly proposals: readonly CapturedProposal[];
};

/** The earliest closure the capture recorded, which is the line the second variant cuts at. */
function firstClosure(capture: IncidentCapture): string | undefined {
  const stamps = capture.claims
    .map((claim) => claim.validUntil)
    .filter((stamp): stamp is string => stamp !== null)
    .sort();
  return stamps[0];
}

function unknownFieldsOf(capture: IncidentCapture): readonly UnknownField[] {
  const unknown: UnknownField[] = [];
  for (const claim of capture.claims) {
    if (claim.occurredAt === null) {
      unknown.push({ subject: claim.id, field: 'occurred_at' });
    }
  }
  for (const edge of capture.lineage) {
    if (edge.createdAt === null) {
      unknown.push({ subject: `${edge.predecessorId}->${edge.successorId}`, field: 'created_at' });
    }
  }
  // The capture holds no Turn identities and no archive content hash or schema version, and
  // the request that produced the closure was never recorded anywhere.
  for (const row of capture.archive) {
    unknown.push({ subject: row.id, field: 'schema_version' });
    unknown.push({ subject: row.id, field: 'content_hash' });
  }
  for (const proposal of capture.proposals) {
    unknown.push({ subject: proposal.id, field: 'submitted_prompt' });
  }
  return unknown;
}

function originalIds(capture: IncidentCapture): Readonly<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [index, claim] of capture.claims.entries()) {
    ids[`claim_${String(index)}`] = claim.id;
  }
  for (const [index, source] of capture.sources.entries()) {
    ids[`source_${String(index)}`] = source.episodeId;
  }
  for (const [index, row] of capture.archive.entries()) {
    ids[`archive_${String(index)}`] = row.id;
  }
  for (const [index, proposal] of capture.proposals.entries()) {
    ids[`proposal_${String(index)}`] = proposal.id;
  }
  return ids;
}

/**
 * Packages one named variant.
 *
 * `incident-snapshot` keeps the observed state exactly, wrong semantics included: a migration
 * has to carry the erroneous closure across until a correction operation changes it, and a
 * fixture that quietly repaired it would let that go untested.
 *
 * `isolated-before-judgment` rewinds to before the first recorded closure and lists every edge,
 * stamp and proposal it left out. It exercises prevention, and its manifest says so, because
 * the request the live run actually submitted was never recorded and nothing here reconstructs
 * it.
 */
export function packageIncidentFixture(
  capture: IncidentCapture,
  variant: FixtureVariant,
): IncidentFixture {
  const shared = {
    archive: capture.archive,
    sources: capture.sources,
  };
  const base = {
    manifestVersion: 1,
    capturedAt: capture.observedAt,
    sourceArtifacts: capture.artifacts,
    unknownFields: unknownFieldsOf(capture),
    originalIds: originalIds(capture),
  };

  if (variant === 'incident-snapshot') {
    return {
      ...shared,
      claims: capture.claims,
      lineage: capture.lineage,
      proposals: capture.proposals,
      manifest: {
        ...base,
        variant,
        classification: 'the observed false supersession, closures and proposal included',
        deltas: [],
        expectedAssertions: [
          'the erroneous closure survives a migration until a correction operation changes it',
          'both recorded closures of the same claim are preserved',
          'the claim keeps the occurrence clock the capture recorded',
        ],
      },
    };
  }

  const closure = firstClosure(capture);
  const deltas: VariantDelta[] = [];
  for (const edge of capture.lineage) {
    deltas.push({
      kind: 'excluded_edge',
      subject: `${edge.predecessorId}->${edge.successorId}`,
      reason: 'recorded at or after the first closure',
    });
  }
  for (const claim of capture.claims) {
    if (claim.validUntil !== null) {
      deltas.push({
        kind: 'excluded_stamp',
        subject: claim.id,
        reason: `valid_until ${claim.validUntil} was written at the closure this variant rewinds past`,
      });
    }
  }
  for (const proposal of capture.proposals) {
    deltas.push({
      kind: 'excluded_proposal',
      subject: proposal.id,
      reason: 'raised by the judgment this variant exists to test',
    });
  }

  return {
    ...shared,
    claims: capture.claims.map((claim) => ({ ...claim, validUntil: null, txUntil: null })),
    lineage: [],
    proposals: [],
    manifest: {
      ...base,
      variant,
      classification:
        closure === undefined
          ? 'the captured sources and claims, with no closure recorded'
          : `the captured sources and claims as they stood before ${closure}`,
      deltas,
      expectedAssertions: [
        'the two claims stand together, and neither closes the other',
        'a judgment over this pair is what the fixture exercises, not the unrecorded live request',
      ],
    },
  };
}

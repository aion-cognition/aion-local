import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import type { ReflectionContent } from '../../../reflection/domain/content.js';

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

/**
 * Every artifact this loader reads or the capture preserves. Verification covers the whole set,
 * not only the names a supplied manifest happens to list: a manifest naming one file would
 * otherwise let the others through unchecked, and the decode reads two of them.
 */
export const REQUIRED_ARTIFACTS: readonly string[] = [
  'targets.json',
  'provenance.json',
  'round-9-astra-recall.json',
  'round-9-astra-trace.md',
];

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
  readonly textNorm: string | null;
  /** What the claim is about, which is what a statement-scope case has to compare. */
  readonly subjectId: string | null;
  readonly aspect: string | null;
  readonly sourceEpisodeId: string | null;
  readonly sessionId: string | null;
  readonly extractionMethod: string | null;
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
  readonly summary: string | null;
  /** When the substrate started holding the source. */
  readonly txFrom: string | null;
  /** When the extraction edge from source to claim was written. */
  readonly edgeCreatedAt: string | null;
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
  /**
   * The stored payload as the substrate holds it, redaction included, decoded from the same
   * bytes the digest covered. The ordered turns with their roles and clocks live here and
   * nowhere else: rendered episode text flattens them, and a case about which turn said what
   * cannot be built from the flattened form. It is read at run time from the preserved capture
   * and never written into the repository.
   */
  readonly payload: ReflectionContent;
};

export type CapturedProposal = {
  readonly id: string;
  readonly oldId: string;
  readonly newId: string;
  readonly episodeId: string | null;
  readonly confidence: number | null;
  /** What the judgment said, which is the evidence a false closure is read against. */
  readonly rationale: string | null;
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
    textNorm: asNullableString(entry.textNorm),
    subjectId: asNullableString(entry.subjectId),
    aspect: asNullableString(entry.aspect),
    sourceEpisodeId: asNullableString(entry.sourceEpisodeId),
    sessionId: asNullableString(entry.sessionId),
    extractionMethod: asNullableString(entry.extractionMethod),
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
    summary: asNullableString(entry.summary),
    txFrom: asNullableString(entry.txFrom),
    edgeCreatedAt: asNullableString(entry.edgeCreatedAt),
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
    payloadBytes: Buffer.byteLength(asString(entry.payload_json), 'utf8'),
    payload: JSON.parse(asString(entry.payload_json) || '{}') as ReflectionContent,
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
    episodeId: asNullableString(entry.episode_id),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
    rationale: asNullableString(entry.rationale),
    createdAt: asNullableString(entry.created_at),
    resolvedAt: asNullableString(entry.resolved_at),
  }));
}

/**
 * Reads every required file once and keeps the bytes. Hashing one read and decoding another
 * would verify bytes nobody parsed, so the buffer that passed the digest is the buffer the
 * decode sees.
 */
function readArtifacts(dir: string): {
  readonly observed: readonly ObservedArtifact[];
  readonly buffers: ReadonlyMap<string, Buffer>;
} {
  const observed: ObservedArtifact[] = [];
  const buffers = new Map<string, Buffer>();
  for (const name of REQUIRED_ARTIFACTS) {
    try {
      const bytes = readFileSync(join(dir, name));
      buffers.set(name, bytes);
      observed.push({ name, sha256: sha256(bytes), bytes: bytes.byteLength });
    } catch {
      // Left out of the observed set on purpose: the manifest comparison is what reports it
      // missing, and it reports it by name.
    }
  }
  return { observed, buffers };
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

  const { observed, buffers } = readArtifacts(dir);
  const outcome = verifyPreservedArtifacts(manifestText, observed, REQUIRED_ARTIFACTS);
  if (outcome.status === 'failed') {
    return outcome;
  }

  let targets: Record<string, unknown>;
  let provenance: Record<string, unknown>;
  try {
    targets = JSON.parse(buffers.get('targets.json')?.toString('utf8') ?? '') as Record<
      string,
      unknown
    >;
    provenance = JSON.parse(buffers.get('provenance.json')?.toString('utf8') ?? '') as Record<
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

/** Every scalar the capture left null, named rather than defaulted, plus the fields it never held. */
function unknownFieldsOf(capture: IncidentCapture): readonly UnknownField[] {
  const unknown: UnknownField[] = [];
  const claimFields = [
    ['occurredAt', 'occurred_at'],
    ['textNorm', 'text_norm'],
    ['subjectId', 'subject_id'],
    ['aspect', 'aspect'],
    ['sourceEpisodeId', 'source_episode_id'],
    ['sessionId', 'session_id'],
    ['extractionMethod', 'extraction_method'],
    ['txFrom', 'tx_from'],
  ] as const;
  for (const claim of capture.claims) {
    for (const [key, field] of claimFields) {
      if (claim[key] === null) {
        unknown.push({ subject: claim.id, field });
      }
    }
  }
  for (const source of capture.sources) {
    if (source.summary === null) {
      unknown.push({ subject: source.episodeId, field: 'summary' });
    }
    if (source.txFrom === null) {
      unknown.push({ subject: source.episodeId, field: 'tx_from' });
    }
    if (source.edgeCreatedAt === null) {
      unknown.push({ subject: source.episodeId, field: 'extraction_edge_created_at' });
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
    for (const [index, turn] of (row.payload.turns ?? []).entries()) {
      unknown.push({ subject: `${row.episodeId}#${String(index)}`, field: 'turn_id' });
      if (turn.occurred_at === undefined) {
        unknown.push({ subject: `${row.episodeId}#${String(index)}`, field: 'turn_occurred_at' });
      }
    }
  }
  for (const proposal of capture.proposals) {
    unknown.push({ subject: proposal.id, field: 'submitted_prompt' });
    if (proposal.rationale === null) {
      unknown.push({ subject: proposal.id, field: 'rationale' });
    }
  }
  return unknown;
}

/**
 * Held back from every variant, so no field leaves the capture without a line saying so. The
 * stored vectors are floats taken over text the fixture already carries; a case about them
 * re-embeds rather than replays, and carrying two 1024-float arrays per node would make the
 * fixture unreadable.
 */
function sharedExclusions(capture: IncidentCapture): readonly VariantDelta[] {
  return capture.claims.map((claim) => ({
    kind: 'excluded_stamp' as const,
    subject: claim.id,
    reason: 'stored content and context vectors are held back from every variant',
  }));
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
        deltas: sharedExclusions(capture),
        expectedAssertions: [
          'the erroneous closure survives a migration until a correction operation changes it',
          'both recorded closures of the same claim are preserved',
          'the claim keeps the occurrence clock the capture recorded',
        ],
      },
    };
  }

  const closure = firstClosure(capture);
  const deltas: VariantDelta[] = [...sharedExclusions(capture)];
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
    if (claim.txUntil !== null) {
      deltas.push({
        kind: 'excluded_stamp',
        subject: claim.id,
        reason: `tx_until ${claim.txUntil} was written at the same closure`,
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

export type IndependentReader =
  | { readonly status: 'independent'; readonly sessionId: string }
  | { readonly status: 'rejected'; readonly reason: 'resolves_to_source_session' };

/**
 * Whether a reader asking about this incident is a different reader from the ones that wrote
 * it. Resolution goes through the session manager rather than through the identity string,
 * because an alias that resolves to a source session is that session asking about itself, and
 * a recall measured that way is measuring a session reading its own record.
 */
export function independentReaderSession(
  sessions: { sessionIdFor: (identity: string) => string },
  identity: string,
  capture: IncidentCapture,
): IndependentReader {
  const sessionId = sessions.sessionIdFor(identity);
  const sources = new Set([
    ...capture.sources.map((source) => source.sessionId),
    ...capture.archive.map((row) => row.sessionId),
    ...capture.archive.map((row) => row.identity),
  ]);
  if (sources.has(sessionId)) {
    return { status: 'rejected', reason: 'resolves_to_source_session' };
  }
  return { status: 'independent', sessionId };
}

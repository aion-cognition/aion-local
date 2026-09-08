import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  verifyPreservedArtifacts,
  type ObservedArtifact,
  type PackagingOutcome,
} from '../../../introspection/domain/campaign-artifacts.js';
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

export {
  independentReaderSession,
  packageIncidentFixture,
  type IncidentFixture,
  type IndependentReader,
} from './consolidation-variants.fixture.js';

import { sourceScopeDependencies } from '../../evidence/application/dependencies.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  chunkOfSource,
  listChunkMembers,
  narrativeRevisionBinding,
} from '../../infrastructure/sqlite/chunk-manifest.js';
import { committedIncidenceForSource } from '../../infrastructure/sqlite/committed-evidence.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { SURVIVOR_WORK_KIND } from '../../infrastructure/sqlite/eviction-manifests.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
import { readSearchCapability } from '../../infrastructure/sqlite/fts-capability.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import {
  listReferenceBatches,
  readSourceParts,
  readSourcePartTurnIds,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  hasPendingSourceState,
  isSourceForgotten,
  readSourceResidency,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { readGenerationWork } from '../../infrastructure/sqlite/source-readiness.js';
import { searchIndexPin } from '../../infrastructure/sqlite/source-search-store.js';
import type { CoverageGap } from '../domain/chunk-revision.js';
import { EVICTION_ROLES } from '../domain/episode-eviction.js';

/**
 * Whether a source's raw projection may be removed, asked of the durable records alone.
 *
 * Every one of C9 §4's seven conditions is positively verified here and nothing is inferred from
 * an absence: a missing record is a pin with a name, never a condition that passed quietly. The
 * order runs cheapest-first and stops at the first pin, because a source is held by one unmet
 * condition exactly as firmly as by seven and the caller reports the reason rather than a list.
 *
 * It reads SQLite and nothing else, which is what lets the observation tick score demand from the
 * same predicate a run fences on. The graph half — the incident census and its classification —
 * is the caller's, under the guard.
 */

export type EligibilityVerdict =
  | { readonly status: 'eligible'; readonly candidate: EvictionCandidate }
  | { readonly status: 'pinned'; readonly reason: string };

export type EvictionCandidate = {
  readonly sourceId: string;
  readonly sessionId: string;
  readonly chunkId: string;
  readonly publishedRevisionNo: number;
  readonly processingGeneration: number;
  readonly operationalRevision: number;
  readonly readinessPolicyRevision: number;
  readonly projectionGeneration: number;
  /** The original owned Turn ids, in recorded part order. Only these enter the removal set. */
  readonly turnIds: readonly string[];
  readonly coverageEpoch: string;
  /** The four fixed source scopes, versioned, bound into the intent and rechecked under the guard. */
  readonly dependencies: readonly EvidenceDependency[];
  /** The archive digests the manifest records, so a changed byte invalidates the attempt. */
  readonly contentDigests: Readonly<Record<string, string>>;
  readonly searchCoverageProof: Readonly<Record<string, unknown>>;
  /** The newest accepted reference batch, bound as the source fence's third value. */
  readonly acceptedReferenceVersion: number;
  /** The latest of acceptance, chunk acknowledgment and reference settlement. */
  readonly qualifiedAt: string;
};

export type EvictionPolicy = {
  readonly now: Date;
  readonly minAgeMs: number;
  /**
   * The attempt already holding this source's retiring generation, when one is being resumed.
   *
   * A retiring source is otherwise pinned, which is right for every caller except the recovery
   * of the attempt that made it retiring: that one is not another writer meeting a transition in
   * flight, it is the transition. The identity and the generation both have to match, so a stale
   * operation cannot resume into a transition a later attempt has since taken over.
   */
  readonly resuming?: {
    readonly operationId: string;
    readonly projectionGeneration: number;
  };
};

function pinned(reason: string): EligibilityVerdict {
  return { status: 'pinned', reason };
}

/**
 * The window's anchor: the newest of the three clocks that make a source's current coverage
 * complete, so elapsed validation time is measured from the last thing that could still be wrong
 * rather than from whichever of them happened first.
 */
function qualificationAnchor(
  db: SqliteHandle,
  sourceId: string,
  acceptedAt: string,
  chunkKnownFrom: string,
): string {
  const settled = listStatedLinks(db, sourceId)
    .map((link) => link.knownFrom)
    .filter((known): known is string => known !== null);
  return [acceptedAt, chunkKnownFrom, ...settled].reduce((newest, clock) =>
    clock > newest ? clock : newest,
  );
}

/**
 * Whether a statement accepted about this source is still waiting to be published.
 *
 * A stated link version with no `known_from` is durable, accepted and unsettled: the acceptance
 * landed in the records and its graph projection has not been written. Removing the projection
 * underneath one strands it — the write it is waiting for names a node that will not exist, and
 * no later pass can tell that from a statement nobody ever made. Condition 5 says remaining
 * obligations are acknowledged or transferred, and this is one of them.
 */
function referenceSettlementOwed(db: SqliteHandle, sourceId: string): boolean {
  return listStatedLinks(db, sourceId).some((link) => link.knownFrom === null);
}

/**
 * Coverage gaps this source's own eviction may stand beside.
 *
 * A gap addressed at THIS source disqualifies it however it is spelled. A proved
 * `suppressed_member` gap on another member does not: the suppression is a fact about that
 * member, the coverage over this one is healthy, and the suppressed member pins itself when its
 * own turn comes. Every other gap on another member is left disqualifying, because the signed
 * rider names one reason and reading it as a licence for the rest would be a wider claim than
 * anyone made.
 */
function gapsAllow(gapsJson: string | null, sourceId: string): boolean {
  if (gapsJson === null) {
    return false;
  }
  let gaps: readonly CoverageGap[];
  try {
    gaps = JSON.parse(gapsJson) as readonly CoverageGap[];
  } catch {
    return false;
  }
  return gaps.every((gap) => gap.reason === 'suppressed_member' && gap.sourceId !== sourceId);
}

/** Obligations the source still owes, ignoring the eviction's own survivor tasks. */
function owesWork(db: SqliteHandle, sourceId: string, generation: number): boolean {
  return readGenerationWork(db, sourceId, generation).some(
    (work) => work.kind !== SURVIVOR_WORK_KIND && !['completed', 'obsolete'].includes(work.state),
  );
}

function pairingHolds(db: SqliteHandle): string | undefined {
  const pairing = readSubstratePairing(db);
  if (pairing?.bootstrapState !== 'initialized') {
    return 'substrate_pairing_unproved';
  }
  if (pairing.activationCapabilityRevision <= 0) {
    return 'compatibility_not_established';
  }
  return undefined;
}

function archiveHolds(
  db: SqliteHandle,
  sourceId: string,
): { readonly digests: Record<string, string> } | string {
  const record = readSourceRecord(db, sourceId);
  if (record === undefined) {
    return 'source_record_missing';
  }
  if (record.verificationStatus !== 'verified' || record.canonicalArchiveId === null) {
    return `source_${record.verificationStatus}`;
  }
  const parts = readSourceParts(db, sourceId);
  if (parts.length === 0) {
    return 'source_parts_missing';
  }
  const digests: Record<string, string> = {
    content: record.verifiedContentDigest ?? '',
    identity: record.identityHash ?? '',
  };
  for (const part of parts) {
    digests[`${part.partKind}:${String(part.ordinal)}`] = part.contentHash;
  }
  return { digests };
}

/**
 * The fence. Nothing after a pin is read, so the reason returned is the first condition the
 * source actually failed rather than the last one evaluated.
 */
export function durableEligibility(
  db: SqliteHandle,
  sourceId: string,
  policy: EvictionPolicy,
): EligibilityVerdict {
  const paired = pairingHolds(db);
  if (paired !== undefined) {
    return pinned(paired);
  }
  const coverage = readCurrentCoverageContract(db);
  if (coverage?.state !== 'active') {
    return pinned('coverage_not_active');
  }
  const residency = readSourceResidency(db, sourceId);
  const held = residency?.projectionGeneration ?? 0;
  const state = residency?.state ?? 'resident';
  const resumed =
    state === 'retiring' &&
    policy.resuming !== undefined &&
    residency?.activeOperationId === policy.resuming.operationId &&
    residency.projectionGeneration === policy.resuming.projectionGeneration;
  if (state !== 'resident' && !resumed) {
    return pinned(`residency_${state}`);
  }
  if (hasPendingSourceState(db, sourceId) || isSourceForgotten(db, sourceId)) {
    return pinned('source_state_unsettled');
  }
  const archive = archiveHolds(db, sourceId);
  if (typeof archive === 'string') {
    return pinned(archive);
  }
  const record = readSourceRecord(db, sourceId);
  if (record === undefined) {
    return pinned('source_record_missing');
  }
  const chunkId = chunkOfSource(db, sourceId);
  if (chunkId === undefined) {
    return pinned('source_not_chunked');
  }
  const head = readPublishedRevision(db, CHUNK_REVISION_FAMILY, chunkId);
  if (head?.knownFrom == null) {
    return pinned('chunk_head_unpublished');
  }
  if (!gapsAllow(head.coverageGapsJson, sourceId)) {
    return pinned('chunk_coverage_incomplete');
  }
  const generation = readActiveGeneration(db, sourceId);
  if (generation === undefined) {
    return pinned('processing_generation_inactive');
  }
  if (!generation.inventoryComplete) {
    return pinned('stage_inventory_incomplete');
  }
  if (owesWork(db, sourceId, generation.processingGeneration)) {
    return pinned('source_work_outstanding');
  }
  if (referenceSettlementOwed(db, sourceId)) {
    return pinned('reference_settlement_owed');
  }
  if (readSearchCapability(db).status !== 'available') {
    return pinned('search_capability_unavailable');
  }
  const indexPin = searchIndexPin(db, sourceId);
  if (indexPin.pinned) {
    return pinned(`search_${indexPin.reason}`);
  }
  const qualifiedAt = qualificationAnchor(db, sourceId, record.createdAt, head.knownFrom);
  if (Date.parse(qualifiedAt) + policy.minAgeMs > policy.now.getTime()) {
    return pinned('qualification_age_unmet');
  }
  return {
    status: 'eligible',
    candidate: {
      sourceId,
      sessionId: record.sessionId,
      chunkId,
      publishedRevisionNo: head.revisionNo,
      processingGeneration: generation.processingGeneration,
      operationalRevision: generation.operationalRevision,
      readinessPolicyRevision: generation.policyRevision,
      projectionGeneration: resumed ? held : held + 1,
      turnIds: readSourcePartTurnIds(db, sourceId),
      coverageEpoch: coverage.epoch,
      dependencies: sourceScopeDependencies(db, sourceId),
      contentDigests: archive.digests,
      searchCoverageProof: {
        capability: 'available',
        indexPolicy: 'current',
        parts: readSourceParts(db, sourceId).length,
        complete: true,
      },
      acceptedReferenceVersion: listReferenceBatches(db, sourceId).at(-1)?.referenceVersion ?? 0,
      qualifiedAt,
    },
  };
}

/**
 * A frozen chunk's membership, which is the durable record a chunk-family coverage edge is the
 * physical face of.
 *
 * Chunk coverage does not live in the incidence table and should not: a frozen membership is the
 * manifest's, and copying it into a second place would make two records of one fact that can
 * disagree. A legacy whole-session coverage edge is the other case and keeps its incidence row,
 * so both are proved and neither is assumed from the other.
 */
function chunkCoverageProves(db: SqliteHandle, sourceId: string, nodeId: string): boolean {
  const binding = narrativeRevisionBinding(db, nodeId);
  return binding?.family === 'chunk' && listChunkMembers(db, binding.familyKey).includes(sourceId);
}

/**
 * Whether the durable records already carry every logical fact a preserved edge is the physical
 * face of.
 *
 * Asked as identity rather than as a count: a mention row on one node cannot answer for a
 * mention on another, so each (node, role) the classifier named is looked for by name. A role
 * whose row is missing is the case the whole cut exists to refuse — the edge would go and
 * nothing would be left saying the fact was ever true.
 */
export function incidenceProves(
  db: SqliteHandle,
  sourceId: string,
  required: readonly { readonly nodeId: string; readonly role: string }[],
): { readonly status: 'proved' } | { readonly status: 'missing'; readonly reason: string } {
  if (required.length === 0) {
    return { status: 'proved' };
  }
  const held = new Set(
    committedIncidenceForSource(db, sourceId).map((row) => `${row.nodeId} ${row.role}`),
  );
  const absent = required.find(
    (entry) =>
      !held.has(`${entry.nodeId} ${entry.role}`) &&
      !(entry.role === EVICTION_ROLES.coverage && chunkCoverageProves(db, sourceId, entry.nodeId)),
  );
  return absent === undefined
    ? { status: 'proved' }
    : { status: 'missing', reason: `incidence_unrecorded_${absent.role}` };
}

import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { LEGACY_HEAD_LIMIT } from './family-cutover.js';
import { readFamilyFence, type FamilyReading } from './family-fence.js';
import { findLegacyHeads } from '../../infrastructure/graph/narrative-families.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { readCutoverPartition } from '../../infrastructure/sqlite/migration-session.js';

export type NarrativeFamilyDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly publications: PublicationCoordinator;
};

export type FamilyReady =
  | { readonly status: 'ready'; readonly reading: FamilyReading }
  | { readonly status: 'deferred'; readonly reason: string };

/** Called only by writers. A read never initializes the preference or its proof counter. */
export async function ensureSessionFamily(
  deps: NarrativeFamilyDeps,
  sessionId: string,
): Promise<FamilyReady> {
  const held = readFamilyFence(deps.db, sessionId);
  if (held !== undefined) {
    return { status: 'ready', reading: held };
  }
  if (readFamilySelection(deps.db, sessionId) !== undefined) {
    return { status: 'deferred', reason: 'family_scope_unverified' };
  }
  const coverage = readCurrentCoverageContract(deps.db);
  if (coverage === undefined) {
    return { status: 'deferred', reason: 'coverage_unavailable' };
  }
  const payload = {
    action: 'initialize',
    sessionId,
    coverageEpoch: coverage.epoch,
    expectedVersion: 0,
  } as const;
  // A refused attempt is immutable; a repaired prerequisite gets a new attempt identity.
  const outcome = await deps.publications.publish({
    kind: 'family_cutover',
    operationId: `family-initialize:${randomUUID()}`,
    payload,
  });
  const reading = readFamilyFence(deps.db, sessionId);
  return reading === undefined
    ? {
        status: 'deferred',
        reason: outcome.status === 'acknowledged' ? 'family_scope_unverified' : outcome.reason,
      }
    : { status: 'ready', reading };
}

/** Binds the actual fixed partition and legacy heads before the guard checks them again. */
export async function cutoverSessionFamily(
  deps: NarrativeFamilyDeps,
  input: { readonly sessionId: string; readonly cohortId: string },
): Promise<
  PublicationOutcome | { readonly status: 'already_selected' | 'deferred'; readonly reason: string }
> {
  const ready = await ensureSessionFamily(deps, input.sessionId);
  if (ready.status !== 'ready') {
    return ready;
  }
  if (ready.reading.selection.family === 'chunk') {
    return { status: 'already_selected', reason: 'the session already selects chunks' };
  }
  const coverage = readCurrentCoverageContract(deps.db);
  if (coverage === undefined) {
    return { status: 'deferred', reason: 'coverage_unavailable' };
  }
  const partition = readCutoverPartition(deps.db, input.cohortId, input.sessionId);
  if (partition.reason !== undefined) {
    return { status: 'deferred', reason: partition.reason };
  }
  const expectedHeads = await findLegacyHeads(deps.driver, input.sessionId, LEGACY_HEAD_LIMIT + 1);
  if (expectedHeads.length > LEGACY_HEAD_LIMIT) {
    return { status: 'deferred', reason: 'legacy_heads_bound' };
  }
  const payload = {
    action: 'cutover',
    ...input,
    coverageEpoch: coverage.epoch,
    expectedVersion: ready.reading.selection.version,
    partitionDigest: partition.digest,
    expectedHeads: [...expectedHeads],
  } as const;
  return deps.publications.publish({
    kind: 'family_cutover',
    operationId: `family-cutover:${randomUUID()}`,
    payload,
  });
}

/** Each version has a separate receipt, so an inventory resumes without rewriting prior text. */
export async function inventoryLegacyNarrative(
  deps: NarrativeFamilyDeps,
  input: { readonly sessionId: string; readonly narrativeId: string },
): Promise<PublicationOutcome | { readonly status: 'deferred'; readonly reason: string }> {
  const ready = await ensureSessionFamily(deps, input.sessionId);
  if (ready.status !== 'ready') {
    return ready;
  }
  const coverage = readCurrentCoverageContract(deps.db);
  if (coverage === undefined) {
    return { status: 'deferred', reason: 'coverage_unavailable' };
  }
  // The receipt is per attempt: verification can improve when a previously pinned source is repaired.
  const payload = {
    action: 'inventory',
    ...input,
    coverageEpoch: coverage.epoch,
    expectedVersion: ready.reading.selection.version,
  } as const;
  return deps.publications.publish({
    kind: 'family_cutover',
    operationId: `family-inventory:${randomUUID()}`,
    payload,
  });
}

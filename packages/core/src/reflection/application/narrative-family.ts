import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import { readFamilyFence, type FamilyReading } from './family-fence.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readFamilySelection } from '../../infrastructure/sqlite/family-selection.js';

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
  // A refused attempt is immutable; a repaired prerequisite gets a new attempt identity.
  const outcome = await deps.publications.publish({
    kind: 'narrative_family_selection',
    operationId: `family-initialize:${randomUUID()}`,
    payload: { sessionId, coverageEpoch: coverage.epoch, expectedVersion: 0 },
  });
  const reading = readFamilyFence(deps.db, sessionId);
  return reading === undefined
    ? {
        status: 'deferred',
        reason: outcome.status === 'acknowledged' ? 'family_scope_unverified' : outcome.reason,
      }
    : { status: 'ready', reading };
}

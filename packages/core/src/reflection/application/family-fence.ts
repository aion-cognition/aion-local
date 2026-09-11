import { readRelationScope } from '../../evidence/application/dependencies.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  readFamilySelection,
  type FamilySelection,
} from '../../infrastructure/sqlite/family-selection.js';

/** One counter fences both default representation reads and the legacy writers they replace. */
export const FAMILY_SELECTION_SCOPE = 'sqlite.family_selection';

export type FamilyReading = {
  readonly selection: FamilySelection;
  readonly dependency: EvidenceDependency;
};

/** A preference without a writer-established scope cannot certify a family decision. */
export function readFamilyFence(
  db: SqliteHandle,
  sessionId: string,
  knownAt?: Date,
): FamilyReading | undefined {
  const selection = readFamilySelection(db, sessionId, knownAt);
  const scope = readRelationScope(db, {
    kind: 'relation_scope',
    endpointId: sessionId,
    scope: FAMILY_SELECTION_SCOPE,
    empty: false,
  });
  return selection === undefined || scope.status !== 'verified'
    ? undefined
    : { selection, dependency: scope.dependency };
}

/** The number is parked before graph work and becomes visible only with the preference ACK. */
export function prepareFamilyAdvance(
  db: SqliteHandle,
  sessionId: string,
  operationId: string,
  at: Date,
): void {
  prepareScopeAdvance(db, {
    endpointId: sessionId,
    relationClass: FAMILY_SELECTION_SCOPE,
    operationId,
    updatedAt: at,
  });
}

export function acknowledgeFamilyAdvance(
  db: SqliteHandle,
  sessionId: string,
  operationId: string,
  knownFrom: string,
): void {
  acknowledgeScopeAdvance(db, {
    endpointId: sessionId,
    relationClass: FAMILY_SELECTION_SCOPE,
    operationId,
    updatedAt: new Date(knownFrom),
    censusStatus: 'established',
    coverageJson: JSON.stringify({
      sessionId,
      operationId,
      knownFrom,
      basis: 'family_publication',
    }),
  });
}

export function discardFamilyAdvance(
  db: SqliteHandle,
  sessionId: string,
  operationId: string,
): void {
  rejectScopeAdvance(db, {
    endpointId: sessionId,
    relationClass: FAMILY_SELECTION_SCOPE,
    operationId,
    updatedAt: new Date(),
  });
}

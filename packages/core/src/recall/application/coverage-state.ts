import { readCoverageStanding } from './coverage-checker.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';

/**
 * What the operator surfaces say about coverage, read and never taken.
 *
 * The three states are what a reader would actually get. `active` means temporal reads carry a
 * horizon. `preparing` means the contract exists and promises no history, so every temporal read
 * comes back partial with `coverage_contract_not_active`; a start that has not activated yet and
 * a start whose activation was refused both read this way, and the reason is reported where the
 * refusal happened. `failed` means the record cannot be served at all, which refuses every
 * covered read including the ones that only ask about now.
 *
 * The eviction fence travels beside it because the two are read off one row and mean opposite
 * things. Reporting coverage alone invites the reading that an active contract is a substrate
 * eviction may remove from; it is not, and this is where the difference is visible.
 */
export type CoverageStateReport = {
  readonly coverageState: 'preparing' | 'active' | 'failed';
  readonly historySince: string | null;
  readonly coverageEpoch: string | null;
  readonly evictionGate: 'armed' | 'unarmed';
  readonly evictionCompatibilityRevision: number;
};

export function readCoverageState(db: SqliteHandle): CoverageStateReport {
  const revision = readSubstratePairing(db)?.evictionCompatibilityRevision ?? 0;
  const eviction = {
    evictionGate: revision > 0 ? ('armed' as const) : ('unarmed' as const),
    evictionCompatibilityRevision: revision,
  };
  const standing = readCoverageStanding(db);
  if (standing === undefined) {
    return { coverageState: 'failed', historySince: null, coverageEpoch: null, ...eviction };
  }
  return {
    coverageState: standing.coverageState,
    historySince: standing.historySince ?? null,
    coverageEpoch: standing.epoch,
    ...eviction,
  };
}

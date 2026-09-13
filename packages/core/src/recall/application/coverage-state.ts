import { readCoverageStanding } from './coverage-checker.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * What the operator surfaces say about coverage, read and never taken.
 *
 * The three states are what a reader would actually get. `active` means temporal reads carry a
 * horizon. `preparing` means the contract exists and promises no history, so every temporal read
 * comes back partial with `coverage_contract_not_active`; a start that has not activated yet and
 * a start whose activation was refused both read this way, and the reason is reported where the
 * refusal happened. `failed` means the record cannot be served at all, which refuses every
 * covered read including the ones that only ask about now.
 */
export type CoverageStateReport = {
  readonly coverageState: 'preparing' | 'active' | 'failed';
  readonly historySince: string | null;
  readonly coverageEpoch: string | null;
};

export function readCoverageState(db: SqliteHandle): CoverageStateReport {
  const standing = readCoverageStanding(db);
  if (standing === undefined) {
    return { coverageState: 'failed', historySince: null, coverageEpoch: null };
  }
  return {
    coverageState: standing.coverageState,
    historySince: standing.historySince ?? null,
    coverageEpoch: standing.epoch,
  };
}

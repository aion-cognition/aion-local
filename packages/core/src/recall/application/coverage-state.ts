import { readCoverageStanding } from './coverage-checker.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  evictionStopStands,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';

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
 *
 * The fence has three readings and not two. `unarmed` is a substrate nobody ever opened;
 * `disarmed` is one somebody opened and then stopped, which is a different fact with a different
 * history and is reported as one. Both refuse every eviction.
 *
 * A stop asked for and not yet recorded reads `disarmed` too, with the asking operation named and
 * no moment, because that is what eviction does with it. A surface that reported armed there would
 * disagree with the fence.
 */
export type CoverageStateReport = {
  readonly coverageState: 'preparing' | 'active' | 'failed';
  readonly historySince: string | null;
  readonly coverageEpoch: string | null;
  readonly evictionGate: 'armed' | 'unarmed' | 'disarmed';
  readonly evictionCompatibilityRevision: number;
  /** When somebody stopped it, null when nobody has and null while a stop is still being asked. */
  readonly evictionDisarmedAt: string | null;
  /** The operation asking for a stop that is not recorded yet. It refuses evictions meanwhile. */
  readonly evictionStopRequestedBy: string | null;
};

/** The stop is read first, because it refuses whatever the number says. */
function evictionGateOf(revision: number, stopped: boolean): 'armed' | 'unarmed' | 'disarmed' {
  if (stopped) {
    return 'disarmed';
  }
  return revision > 0 ? 'armed' : 'unarmed';
}

export function readCoverageState(db: SqliteHandle): CoverageStateReport {
  const pairing = readSubstratePairing(db);
  const revision = pairing?.evictionCompatibilityRevision ?? 0;
  const disarmedAt = pairing?.evictionDisarmedAt ?? null;
  // The same rule the fence reads, so a surface can never report armed while eviction refuses.
  const stopped = evictionStopStands(db, pairing);
  const eviction = {
    evictionGate: evictionGateOf(revision, stopped),
    evictionCompatibilityRevision: revision,
    evictionDisarmedAt: disarmedAt,
    evictionStopRequestedBy:
      stopped && disarmedAt === null ? (pairing?.evictionStopRequestedBy ?? null) : null,
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

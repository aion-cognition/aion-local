import {
  describeObservationWindow,
  readObservationWindow,
  type ObservationWindow,
} from './observation-window.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { BridgeTraversalPayload } from '../../../infrastructure/sqlite/sense-usage-events.js';

/**
 * The bridge-traversal sense: what `activation.ts`'s walk actually crossed, read back from the
 * `bridge_traversal_observed` rows `side-effects.ts` appends. A bridge earns this reading from
 * use, never from mint-time confidence, and a bridge nothing has traversed yet is a young bridge
 * with no observed use, not an unsuccessful one.
 *
 * Folded per bridge across every row in the window, because one bridge can appear in many recalls
 * and the evidence line is about the bridge's own record, not about any one walk.
 */

const OBSERVATION_SCAN_LIMIT = 5_000;

export type BridgeTraversalSummary = {
  readonly bridgesObserved: number;
  readonly bridgesCrossed: number;
  readonly bridgesLegOnly: number;
  readonly bridgesEverEmitted: number;
  /** Rows read to build this summary; a scan under the table's true size names its own limit. */
  readonly recordsScanned: number;
  readonly window: ObservationWindow;
};

export function summarizeBridgeTraversal(
  db: SqliteHandle,
  limit: number = OBSERVATION_SCAN_LIMIT,
): BridgeTraversalSummary {
  const { rows, window } = readObservationWindow(db, 'bridge_traversal_observed', limit);
  const crossed = new Set<string>();
  const legOnly = new Set<string>();
  const emitted = new Set<string>();
  for (const row of rows) {
    const payload = row.payload as BridgeTraversalPayload;
    if (payload.crossed) {
      crossed.add(payload.bridgeId);
      legOnly.delete(payload.bridgeId);
    } else if (!crossed.has(payload.bridgeId)) {
      legOnly.add(payload.bridgeId);
    }
    if (payload.emitted) {
      emitted.add(payload.bridgeId);
    }
  }
  return {
    bridgesObserved: new Set([...crossed, ...legOnly]).size,
    bridgesCrossed: crossed.size,
    bridgesLegOnly: legOnly.size,
    bridgesEverEmitted: emitted.size,
    recordsScanned: rows.length,
    window,
  };
}

/** One evidence line for the tier-3 prompt, or nothing when no bridge has been observed yet. */
export function bridgeTraversalEvidence(summary: BridgeTraversalSummary): string | undefined {
  if (summary.bridgesObserved === 0) {
    return undefined;
  }
  return (
    `bridge traversal: ${String(summary.bridgesObserved)} bridge(s) observed in a recall walk ` +
    `${describeObservationWindow('bridge traversal', summary.window)}, ` +
    `${String(summary.bridgesCrossed)} crossed end to end on both of the bridge's own recorded ` +
    `legs, ${String(summary.bridgesLegOnly)} contributed on one leg only, ` +
    `${String(summary.bridgesEverEmitted)} had the Bridge node itself reach the pack a caller ` +
    'was served. A bridge with no row here has not been traversed in this window, which is not ' +
    'the same as unused.'
  );
}

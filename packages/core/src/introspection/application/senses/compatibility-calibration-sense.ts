import type { Driver } from 'neo4j-driver';

import {
  describeObservationWindow,
  readObservationWindow,
  type ObservationWindow,
} from './observation-window.js';
import { listPublishedBridges } from '../../../infrastructure/graph/bridge-queries.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { BridgeTraversalPayload } from '../../../infrastructure/sqlite/sense-usage-events.js';
import {
  describeCompatibilityCalibration,
  summarizeCompatibilityCalibration,
  type BridgeTraversalRecord,
  type CompatibilityCalibrationSummary,
} from '../../domain/compatibility-calibration.js';

/**
 * The compatibility-calibration sense, wired: the graph gives every currently published bridge
 * (`listPublishedBridges`, the model's own compatibility reading and author already stored on
 * the node), and the `bridge_traversal_observed` stream `side-effects.ts` appends gives what has
 * actually crossed each one. `domain/compatibility-calibration.ts` does the matching and states
 * the one caveat this whole sense rests on: traversal under a bridge's own weight is a usefulness
 * reading, never independent proof the compatibility judgment was right.
 */

const DEFAULT_BRIDGE_SCAN_LIMIT = 2_000;
const DEFAULT_EVENT_SCAN_LIMIT = 5_000;

export type CompatibilityCalibrationReading = {
  readonly summary: CompatibilityCalibrationSummary;
  readonly bridgeScanIsPartial: boolean;
  readonly window: ObservationWindow;
};

function toRecords(
  db: SqliteHandle,
  limit: number,
): { readonly records: readonly BridgeTraversalRecord[]; readonly window: ObservationWindow } {
  const { rows, window } = readObservationWindow(db, 'bridge_traversal_observed', limit);
  return {
    records: rows.map((row) => {
      const payload = row.payload as BridgeTraversalPayload;
      return { bridgeId: payload.bridgeId, crossed: payload.crossed };
    }),
    window,
  };
}

export async function readCompatibilityCalibration(
  driver: Driver,
  db: SqliteHandle,
  now: Date,
  options: { readonly bridgeLimit?: number; readonly eventLimit?: number } = {},
): Promise<CompatibilityCalibrationReading> {
  const bridgeLimit = options.bridgeLimit ?? DEFAULT_BRIDGE_SCAN_LIMIT;
  const bridges = await listPublishedBridges(driver, bridgeLimit);
  const { records, window } = toRecords(db, options.eventLimit ?? DEFAULT_EVENT_SCAN_LIMIT);
  return {
    summary: summarizeCompatibilityCalibration(bridges, records, now),
    bridgeScanIsPartial: bridges.length >= bridgeLimit,
    window,
  };
}

export function compatibilityCalibrationEvidence(
  reading: CompatibilityCalibrationReading,
): readonly string[] {
  const lines = describeCompatibilityCalibration(reading.summary);
  if (reading.summary.totalPublished === 0) {
    return [];
  }
  const scanNote = reading.bridgeScanIsPartial
    ? ["(bridge read capped; not the whole substrate's published set)"]
    : [];
  return [...lines, describeObservationWindow('bridge traversal', reading.window), ...scanNote];
}

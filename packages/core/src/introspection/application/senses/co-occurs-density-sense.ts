import {
  describeObservationWindow,
  readObservationWindow,
  type ObservationWindow,
} from './observation-window.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type {
  ActivationHubPenaltyPayload,
  CoOccursObservedPayload,
} from '../../../infrastructure/sqlite/sense-usage-events.js';
import {
  describeCoOccursDensity,
  summarizeCoOccursDensity,
  type CoOccursDensitySummary,
} from '../../domain/co-occurs-density.js';

const DEFAULT_SCAN_LIMIT = 2_000;

export type CoOccursDensityReading = {
  readonly summary: CoOccursDensitySummary;
  readonly episodeWindow: ObservationWindow;
  readonly walkWindow: ObservationWindow;
};

export function readCoOccursDensity(
  db: SqliteHandle,
  options: { readonly limit?: number } = {},
): CoOccursDensityReading {
  const limit = options.limit ?? DEFAULT_SCAN_LIMIT;
  const episodeRows = readObservationWindow(db, 'co_occurs_observed', limit);
  const walkRows = readObservationWindow(db, 'activation_hub_penalty_observed', limit);
  return {
    summary: summarizeCoOccursDensity(
      episodeRows.rows.map((row) => row.payload as CoOccursObservedPayload),
      walkRows.rows.map((row) => row.payload as ActivationHubPenaltyPayload),
    ),
    episodeWindow: episodeRows.window,
    walkWindow: walkRows.window,
  };
}

export function coOccursDensityEvidence(reading: CoOccursDensityReading): readonly string[] {
  const lines = describeCoOccursDensity(reading.summary);
  if (lines.length === 0) {
    return [];
  }
  return [
    ...lines,
    describeObservationWindow('association pass', reading.episodeWindow),
    describeObservationWindow('recall walk', reading.walkWindow),
  ];
}

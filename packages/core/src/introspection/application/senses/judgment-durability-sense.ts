import type { Driver } from 'neo4j-driver';

import {
  describeObservationWindow,
  readObservationWindow,
  type ObservationWindow,
} from './observation-window.js';
import { listSupersedesLineage } from '../../../infrastructure/graph/judgment-durability-queries.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { JudgmentTransitionPayload } from '../../../infrastructure/sqlite/sense-usage-events.js';
import {
  describeJudgmentDurability,
  summarizeJudgmentDurability,
  type JudgmentDurabilitySummary,
} from '../../domain/judgment-durability.js';

/**
 * The judgment-durability sense, wired: the graph gives every producer's current lineage-edge
 * population (`listSupersedesLineage`, provenance already stored on the edge and never
 * reinvented here), and `domain/judgment-durability.ts` classifies it. The SQLite stream adds
 * what a later point-in-time graph read would lose: reversals `proposals.ts` and the CLI's
 * `unsupersede` command record the moment they actually commit, so an intermediate reversal a
 * sampled graph snapshot missed is still legible.
 */

const DEFAULT_GRAPH_SCAN_LIMIT = 5_000;
const DEFAULT_EVENT_SCAN_LIMIT = 5_000;

export type JudgmentDurabilityReading = {
  readonly summary: JudgmentDurabilitySummary;
  readonly graphScanIsPartial: boolean;
  readonly reversalsObservedInStream: number;
  readonly window: ObservationWindow;
};

export async function readJudgmentDurability(
  driver: Driver,
  db: SqliteHandle,
  now: Date,
  options: { readonly graphLimit?: number; readonly eventLimit?: number } = {},
): Promise<JudgmentDurabilityReading> {
  const graphLimit = options.graphLimit ?? DEFAULT_GRAPH_SCAN_LIMIT;
  const rows = await listSupersedesLineage(driver, graphLimit);
  const eventLimit = options.eventLimit ?? DEFAULT_EVENT_SCAN_LIMIT;
  const transitions = readObservationWindow(db, 'judgment_transition_observed', eventLimit);
  const reversals = transitions.rows.filter(
    (row) => (row.payload as JudgmentTransitionPayload).transition === 'reopened',
  );
  return {
    summary: summarizeJudgmentDurability(rows, now),
    graphScanIsPartial: rows.length >= graphLimit,
    reversalsObservedInStream: reversals.length,
    window: transitions.window,
  };
}

export function judgmentDurabilityEvidence(reading: JudgmentDurabilityReading): readonly string[] {
  const lines = describeJudgmentDurability(reading.summary);
  if (lines.length === 0) {
    return [];
  }
  const scanNote = reading.graphScanIsPartial
    ? [`(graph read capped; not the whole substrate's lineage)`]
    : [];
  return [
    ...lines,
    ...scanNote,
    `${String(reading.reversalsObservedInStream)} reversal(s) observed directly in the stream ` +
      `${describeObservationWindow('judgment transition', reading.window)}.`,
  ];
}

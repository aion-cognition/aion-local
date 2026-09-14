import {
  describeObservationWindow,
  readObservationWindow,
  EMPTY_OBSERVATION_WINDOW,
  type ObservationWindow,
} from './observation-window.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { ResonanceServedPayload } from '../../../infrastructure/sqlite/sense-usage-events.js';
import { listUsageEventsOfKind } from '../../../infrastructure/sqlite/usage-events.js';
import type {
  MemoryConfirmedPayload,
  ReinforcementAppliedPayload,
  SelfReportPayload,
} from '../../../infrastructure/sqlite/usage-events.js';

/**
 * The resonance-usefulness sense: did what context resonance served get used again, read from
 * `resonance_served` rows joined against whatever later evidence the stream actually carries.
 *
 * Four things are kept apart, per the standing rule against reading exposure as proof of use:
 * emission (`resonance_served` itself), later recurrence through reinforcement, a caller's own
 * `memory_used` report, and a `memory_confirmed` record. A served item with none of the three
 * later kinds is unknown, never counted as unused: the opportunity to reinforce, self-report or
 * confirm it may simply not have arrived yet inside the window this sense scanned.
 */

const OBSERVATION_SCAN_LIMIT = 5_000;

export type ResonanceUsefulnessSummary = {
  readonly served: number;
  readonly laterReinforced: number;
  readonly laterSelfReported: number;
  readonly laterConfirmed: number;
  readonly contested: number;
  readonly unknown: number;
  readonly recordsScanned: number;
  readonly window: ObservationWindow;
};

type LaterEvidence = {
  readonly reinforced: boolean;
  readonly selfReported: boolean;
  readonly confirmed: boolean;
};

function idsIn(
  kind: 'reinforcement_applied' | 'memory_used' | 'memory_confirmed',
  payload: unknown,
): readonly string[] {
  if (kind === 'reinforcement_applied') {
    const { pairs } = payload as ReinforcementAppliedPayload;
    return pairs.flatMap((pair) => [pair.sourceId, pair.targetId]);
  }
  if (kind === 'memory_used') {
    return (payload as SelfReportPayload).memories;
  }
  return (payload as MemoryConfirmedPayload).memories;
}

export function summarizeResonanceUsefulness(
  db: SqliteHandle,
  limit: number = OBSERVATION_SCAN_LIMIT,
): ResonanceUsefulnessSummary {
  const { rows: served, window } = readObservationWindow(db, 'resonance_served', limit);
  if (served.length === 0) {
    return {
      served: 0,
      laterReinforced: 0,
      laterSelfReported: 0,
      laterConfirmed: 0,
      contested: 0,
      unknown: 0,
      recordsScanned: 0,
      window: EMPTY_OBSERVATION_WINDOW,
    };
  }

  // One later-evidence kind per id, occurred-at ordered, so "later than this serving" is a single
  // linear scan rather than a query per served item.
  const laterByKind: Record<
    'reinforcement_applied' | 'memory_used' | 'memory_confirmed',
    Map<string, string[]>
  > = {
    reinforcement_applied: new Map(),
    memory_used: new Map(),
    memory_confirmed: new Map(),
  };
  for (const kind of Object.keys(laterByKind) as (keyof typeof laterByKind)[]) {
    for (const row of listUsageEventsOfKind(db, kind, limit)) {
      for (const id of idsIn(kind, row.payload)) {
        const timestamps = laterByKind[kind].get(id) ?? [];
        timestamps.push(row.occurredAt);
        laterByKind[kind].set(id, timestamps);
      }
    }
  }

  const hasLater = (kind: keyof typeof laterByKind, itemId: string, servedAt: string): boolean =>
    (laterByKind[kind].get(itemId) ?? []).some((at) => at > servedAt);

  let laterReinforced = 0;
  let laterSelfReported = 0;
  let laterConfirmed = 0;
  let contested = 0;
  let unknown = 0;
  for (const row of served) {
    const payload = row.payload as ResonanceServedPayload;
    const evidence: LaterEvidence = {
      reinforced: hasLater('reinforcement_applied', payload.itemId, row.occurredAt),
      selfReported: hasLater('memory_used', payload.itemId, row.occurredAt),
      confirmed: hasLater('memory_confirmed', payload.itemId, row.occurredAt),
    };
    if (evidence.reinforced) {
      laterReinforced += 1;
    }
    if (evidence.selfReported) {
      laterSelfReported += 1;
    }
    if (evidence.confirmed) {
      laterConfirmed += 1;
    }
    if (payload.contested) {
      contested += 1;
    }
    if (!evidence.reinforced && !evidence.selfReported && !evidence.confirmed) {
      unknown += 1;
    }
  }

  return {
    served: served.length,
    laterReinforced,
    laterSelfReported,
    laterConfirmed,
    contested,
    unknown,
    recordsScanned: served.length,
    window,
  };
}

export function resonanceUsefulnessEvidence(
  summary: ResonanceUsefulnessSummary,
): string | undefined {
  if (summary.served === 0) {
    return undefined;
  }
  return (
    `resonance usefulness ${describeObservationWindow('resonance serving', summary.window)}: ` +
    `${String(summary.served)} resonant item(s) served, ` +
    `${String(summary.laterReinforced)} later reinforced, ` +
    `${String(summary.laterSelfReported)} later self-reported as used, ` +
    `${String(summary.laterConfirmed)} later confirmed, ` +
    `${String(summary.contested)} carried a lineage or correction marker at serving, ` +
    `${String(summary.unknown)} with no later record either way (unknown, not unused).`
  );
}

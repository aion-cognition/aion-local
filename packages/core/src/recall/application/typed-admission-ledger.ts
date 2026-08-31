import { isTimeTravel, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';

/**
 * One permanent ledger row per typed-tier admission, keyed so a repeat call for the same pack
 * overwrites rather than duplicates. There is no separate pack identifier to key on; the
 * session and the serve time together are unique to one served pack, which is what a repeat
 * recall for the same session at the same instant would collide on anyway.
 *
 * Precision here is judged later from what a typed admission goes on to do (retro-judged from
 * reinforcement, not in this lane), so the row is the only trace once the pack itself is gone: a
 * wrong admit costs one ephemeral pack item, and this is what is left to judge it by.
 *
 * Skipped on a time-traveled read for the same reason reinforcement itself is: `as_of` and
 * `knew_at` ask what the substrate held at another moment rather than serving what just fired,
 * and reinforcement never follows such a read, so a row it left behind could never be
 * retro-judged by anything.
 */
export function recordTypedAdmissions(
  db: SqliteHandle,
  sessionId: string,
  now: Date,
  mode: ReadMode,
  items: readonly FusedItem[],
  policy: AdmissionPolicy,
): void {
  if (isTimeTravel(mode)) {
    return;
  }
  const packStamp = `${sessionId}:${now.toISOString()}`;
  for (const item of items) {
    if (item.admittedBy?.rule !== 'typed_admission' || item.typedEvidence === undefined) {
      continue;
    }
    markLedgerApplied(db, `typed_admission:${packStamp}:${item.id}`, {
      itemId: item.id,
      edgeType: item.typedEvidence.edgeType,
      activationScore: item.activation ?? item.rationale.score,
      cosine: item.admittedBy.score,
      clearedFloor: policy.corroborationFloor,
      failedFloor: policy.vectorFloor,
    });
  }
}

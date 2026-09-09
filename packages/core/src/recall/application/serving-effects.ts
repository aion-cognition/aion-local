import type { HistoryCoverage, MemoryPack } from '@aion/protocol';

import { applyEvidence, type EvidenceIssue as CoverageEvidenceIssue } from './coverage-reasons.js';
import { coverageLines } from './coverage-text.js';
import { recordTypedAdmissions } from './typed-admission-ledger.js';
import { statedCoverage } from '../../evidence/application/reasons.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { saveLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { recordPackMethodMetrics } from '../../infrastructure/sqlite/method-counters.js';
import { recordRecallOutcome } from '../../infrastructure/sqlite/recall-cadence.js';
import { recordCueOutcome } from '../../infrastructure/sqlite/recall-samples.js';
import { deleteServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import type { FusedItem, MethodLegStats } from '../domain/fusion.js';
import { withSoleMethod } from '../domain/fusion.js';
import { packMethods } from '../domain/pack-methods.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';
import { servedRecords, sessionHoldings } from '../domain/session-dedup.js';

/**
 * Everything a successful recall writes, as two synchronous callbacks over one handle.
 *
 * They are shaped for the completion boundary rather than run where they are built: the fence on
 * the coverage contract and these writes belong in one transaction, and a read that turns out to
 * have finished under a contract that moved must leave the session's holdings exactly as it found
 * them. Splitting the reset out is the same rule: deleting what a caller was served and then
 * refusing the read would take the holdings with it.
 *
 * Nothing here returns a promise. A callback that had not finished when the transaction committed
 * would write under a fence nobody checked.
 */

export type ServingEffectsInput = {
  readonly sessionId: string;
  readonly now: Date;
  readonly mode: ReadMode;
  readonly pack: MemoryPack;
  readonly temporal: { readonly asOf?: string; readonly knewAt?: string };
  readonly admission: { readonly policy: AdmissionPolicy; readonly items: readonly FusedItem[] };
  readonly candidates: ReadonlyMap<string, FusedItem>;
  readonly view: ResolvedEvidenceView;
  readonly suppressed: ReadonlySet<string>;
  /** Whether this read may record what it served. A time-traveled read never does. */
  readonly dedup: boolean;
  readonly cueDegraded: boolean;
  readonly methodStats: MethodLegStats;
  readonly resonantCount: number;
  readonly empty: boolean;
  /** The caller asked for its holdings to be forgotten, which happens only if the read succeeds. */
  readonly resetDelivery: boolean;
};

export type ServingEffects = {
  readonly resetDelivery?: (db: SqliteHandle) => void;
  readonly persist: (db: SqliteHandle) => void;
};

/**
 * What the completion boundary did with the writes, and what the caller gets.
 *
 * `withheld` is a refused read: the caller receives nothing, so nothing is stamped, reinforced
 * or counted as exposure. `degraded` is an answer the boundary would not record: the caller
 * receives it, and it says so.
 */
export type CommitDisposition = 'served' | 'degraded' | 'withheld';

/**
 * Where a checked read's writes go: the completion boundary the entry point holds, which commits
 * them under the same fence it checks the coverage contract at. Without it the writes commit
 * where they always did.
 */
export type RecallCommit = (effects: ServingEffects) => Promise<CommitDisposition>;

/**
 * The writes, at whichever boundary owns them. Reset first either way: a caller that asked to
 * forget its holdings must not have the new record written over the old one. Without a boundary
 * they commit here in one transaction, which is where they committed before one existed.
 */
export async function commitServingEffects(
  db: SqliteHandle,
  effects: ServingEffects,
  commit: RecallCommit | undefined,
): Promise<CommitDisposition> {
  if (commit !== undefined) {
    return commit(effects);
  }
  db.transaction(() => {
    effects.resetDelivery?.(db);
    effects.persist(db);
  })();
  return 'served';
}

export function servingEffects(input: ServingEffectsInput): ServingEffects {
  const persist = (db: SqliteHandle): void => {
    saveLastPack(db, input.sessionId, input.pack, input.now.toISOString(), {
      ...(input.temporal.asOf === undefined ? {} : { asOf: input.temporal.asOf }),
      ...(input.temporal.knewAt === undefined ? {} : { knewAt: input.temporal.knewAt }),
    });
    recordTypedAdmissions(
      db,
      input.sessionId,
      input.now,
      input.mode,
      input.admission.items,
      input.admission.policy,
    );
    // A time-traveled read records nothing: it never suppresses, so recording what it served
    // would make a historical inspection decide what the present-day pack may repeat.
    if (input.dedup) {
      recordServedItems(
        db,
        input.sessionId,
        servedRecords(sessionHoldings(input.pack, input.suppressed), input.candidates, input.view),
        input.now.toISOString(),
      );
    }
    // The cue stage is 60-95% of recall wall time and the first thing contention takes; a
    // degraded pack is otherwise indistinguishable from a healthy one at the item count.
    recordCueOutcome(db, input.cueDegraded);
    // Read off the assembled pack, not the stages that fed it: a bucket cap or the token budget
    // can still drop what fusion admitted, and crediting a dropped item's method would lie about
    // the spirit metric. The leg stats widen that to every contributing method, not just the one
    // the rationale names; resonance is folded in as a sole find, since it skips fusion's merge.
    recordPackMethodMetrics(
      db,
      packMethods(input.pack),
      withSoleMethod(input.methodStats, 'resonance', input.resonantCount),
    );
    // Cadence's raw material: calls per session and the empty-pack rate, from a lifetime
    // total rather than the degraded-rate window above, which trims to the last 500.
    recordRecallOutcome(db, { empty: input.empty });
  };
  return {
    ...(input.resetDelivery
      ? {
          resetDelivery: (db: SqliteHandle): void => {
            deleteServedItems(db, input.sessionId);
          },
        }
      : {}),
    persist,
  };
}

/** Whether the statement says anything a reader of the text alone would need to be told. */
function worthSaying(coverage: HistoryCoverage): boolean {
  return (
    coverage.status === 'partial' ||
    coverage.limitations.length > 0 ||
    coverage.gaps.length > 0 ||
    coverage.as_of !== undefined ||
    coverage.knew_at !== undefined
  );
}

/**
 * The coverage the answer carries: what the checker established, plus the gaps this attempt's
 * evidence named and any the boundary added. A required gap makes the statement partial; proved
 * suppression and certified absence are answers the substrate stands behind and leave it
 * supported.
 *
 * Folded in after assembly rather than inside it, so it moves no bucket and costs no token
 * budget: what the pack covers must not depend on how much of it fit. It does reach the rendered
 * text, in the same words the metadata carries, because a caller who reads only the block is
 * exactly the one who would otherwise take a partial answer for a complete one.
 */
export function withCoverage(
  pack: MemoryPack,
  base: HistoryCoverage,
  view: ResolvedEvidenceView,
  boundary: readonly CoverageEvidenceIssue[] = [],
): MemoryPack {
  const { coverage } = applyEvidence(statedCoverage(base, view.issues).coverage, boundary);
  const lines = worthSaying(coverage) ? coverageLines(coverage) : [];
  return {
    ...pack,
    ...(lines.length === 0
      ? {}
      : { rendered_text: `${pack.rendered_text}\n\n${lines.join('\n')}` }),
    metadata: { ...pack.metadata, history_coverage: coverage },
  };
}

/**
 * What a read whose effects nobody would take says about itself. The field follows the
 * resolver's own word for an uncertified reading; a caller that asked to forget its holdings
 * gets a required gap, because the instruction it sent did not happen.
 */
export function pendingPublicationIssue(resetRequested: boolean): CoverageEvidenceIssue {
  return {
    reason: 'pending_publication',
    field: 'interpretation_text',
    required: resetRequested,
  };
}

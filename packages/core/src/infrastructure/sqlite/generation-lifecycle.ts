import type { SqliteHandle } from './database.js';
import {
  activateProcessingGeneration,
  advanceOperationalRevision,
  readActiveGeneration,
  readGeneration,
} from './processing-generations.js';

/**
 * Replacing a generation, and closing an inventory.
 *
 * A replacement is an explicit re-derivation: the source is to be processed again under a new
 * policy or new input, and the attempts made under the old generation are no longer the pass
 * anything is waiting for. What is superseded is the EXECUTION. An obligation the old generation
 * held for reasons of its own, a settlement owed to a reference somebody accepted or an index
 * pass somebody is waiting on, survives the replacement and completes exactly once, because
 * nothing about re-extracting a source discharges what was promised to a third party.
 *
 * The carried rows keep their work ids, so a runner holding one finds the same row it was given
 * and its idempotency identity does not move underneath it.
 */

/** The reason an execution attempt carries once a replacement takes its place. */
export const SUPERSEDED_GENERATION = 'superseded_generation';

/**
 * The reason a carried obligation is closed instead of moved: the replacement already owes the
 * identical obligation under its own row, so the old one has nothing left to say.
 */
export const DUPLICATE_ON_REPLACEMENT = 'duplicate_obligation_on_replacement';

/**
 * The reason a carried obligation is pinned instead of closed: it and the replacement's own row
 * under the same key have each got somewhere, and nothing here can prove the two are the same
 * work. A pin keeps the evidence and the source resident until somebody decides.
 */
export const CONFLICTING_PROGRESS_ON_REPLACEMENT = 'conflicting_progress_on_replacement';

/**
 * The key a conflicting obligation takes when it moves onto the replacement. Its own key belongs
 * to the row the replacement prepared, and both identities have to survive for anybody to
 * reconcile them.
 */
export const CONFLICT_KEY_PREFIX = 'conflict:';

export type GenerationReplacement = {
  readonly sourceId: string;
  /** The generation being made active. It must already be allocated with its inventory written. */
  readonly replacementGeneration: number;
};

export type ReplacementOutcome = {
  readonly readinessRevision: number;
  readonly replacedGeneration: number | undefined;
  /** Execution rows the replacement superseded. */
  readonly obsoleted: number;
  /** Obligations moved onto the replacement with their identity unchanged. */
  readonly carried: number;
};

type CarryRow = {
  work_id: string;
  kind: string;
  work_key: string;
  input_revision_json: string | null;
  continuation_json: string | null;
  attempts: number;
};

/** Whether a row has got anywhere: evidence it was measured against, a cursor, or an attempt. */
function carriesProgress(row: CarryRow): boolean {
  return row.input_revision_json !== null || row.continuation_json !== null || row.attempts > 0;
}

/**
 * Activates the replacement and settles the generation it displaced, in one transaction.
 *
 * Reading the outgoing generation before the activation is what makes the settlement possible at
 * all: activation is what marks it replaced, and afterwards nothing distinguishes the generation
 * this call displaced from one displaced last week.
 */
export function replaceProcessingGeneration(
  db: SqliteHandle,
  replacement: GenerationReplacement,
): ReplacementOutcome {
  return db
    .transaction((): ReplacementOutcome => {
      const outgoing = readActiveGeneration(db, replacement.sourceId);
      const replacedGeneration =
        outgoing !== undefined &&
        outgoing.processingGeneration !== replacement.replacementGeneration
          ? outgoing.processingGeneration
          : undefined;
      const readinessRevision = activateProcessingGeneration(
        db,
        replacement.sourceId,
        replacement.replacementGeneration,
      );
      if (replacedGeneration === undefined) {
        return { readinessRevision, replacedGeneration: undefined, obsoleted: 0, carried: 0 };
      }

      // Execution only. A stage attempt made under the old input is not the pass anybody is
      // waiting for now, and leaving it runnable would let an old worker publish into a
      // generation that no longer exists.
      const obsoleted = db
        .prepare(
          `UPDATE source_work SET state = 'obsolete', reason = ?
           WHERE source_id = ? AND processing_generation = ? AND kind = 'stage'
             AND state IN ('pending','retryable','transferred','pinned','dead_letter')`,
        )
        .run(SUPERSEDED_GENERATION, replacement.sourceId, replacedGeneration).changes;

      const carried = carryObligations(db, replacement, replacedGeneration);
      const advanced = advanceOperationalRevision(
        db,
        replacement.sourceId,
        replacement.replacementGeneration,
      );
      return {
        readinessRevision: advanced ?? readinessRevision,
        replacedGeneration,
        obsoleted,
        carried,
      };
    })
    .immediate();
}

const CARRYABLE_STATES = `('pending','retryable','transferred','pinned','dead_letter')`;
const WORK_COLUMNS = 'work_id, kind, work_key, input_revision_json, continuation_json, attempts';

/**
 * Moves every obligation that is not an execution attempt onto the replacement.
 *
 * A key held on both sides is not proof that the two rows are the same work. The old row may
 * carry the evidence it was measured against and the cursor it reached; the replacement's is
 * usually a skeleton the preparation just wrote. The one that has got somewhere is canonical, so
 * a collision is decided on progress rather than on which generation the row happens to sit in:
 *
 * - the replacement's row has got nowhere: the original is rebound with its work id, evidence and
 *   continuation intact, and the untouched preparation is retired to make room for it. Nothing is
 *   lost, because a prepared row nobody ran is a statement that work is owed and the surviving
 *   row says the same thing with a history attached.
 * - the original has got nowhere: it is closed as a duplicate, which is what it is.
 * - both have: nothing here can prove them equivalent, so the original is PINNED with its
 *   evidence rather than closed, and the source stays resident until somebody decides.
 */
function carryObligations(
  db: SqliteHandle,
  replacement: GenerationReplacement,
  replacedGeneration: number,
): number {
  const rows = db
    .prepare(
      `SELECT ${WORK_COLUMNS} FROM source_work
       WHERE source_id = ? AND processing_generation = ? AND kind != 'stage'
         AND state IN ${CARRYABLE_STATES}`,
    )
    .all(replacement.sourceId, replacedGeneration) as CarryRow[];
  const held = db.prepare(
    `SELECT ${WORK_COLUMNS} FROM source_work
     WHERE source_id = ? AND processing_generation = ? AND kind = ? AND work_key = ?`,
  );
  const move = db.prepare('UPDATE source_work SET processing_generation = ? WHERE work_id = ?');
  const settle = db.prepare('UPDATE source_work SET state = ?, reason = ? WHERE work_id = ?');
  const conflict = db.prepare(
    `UPDATE source_work
       SET processing_generation = ?, work_key = ?, state = 'pinned', reason = ?
     WHERE work_id = ?`,
  );
  const retire = db.prepare('DELETE FROM source_work WHERE work_id = ?');
  let carried = 0;
  for (const row of rows) {
    const existing = held.get(
      replacement.sourceId,
      replacement.replacementGeneration,
      row.kind,
      row.work_key,
    ) as CarryRow | undefined;
    if (existing !== undefined) {
      if (!carriesProgress(row)) {
        settle.run('obsolete', DUPLICATE_ON_REPLACEMENT, row.work_id);
        continue;
      }
      if (carriesProgress(existing)) {
        // The conflict is carried onto the replacement, not left behind with the generation
        // nobody runs. A pin in a replaced generation is invisible to active readiness, to the
        // session count and to every nomination, so a source whose obligations nobody can
        // reconcile reads as a source that owes nothing. It moves under a key of its own,
        // because the obligation it names is the reconciliation rather than the settlement.
        conflict.run(
          replacement.replacementGeneration,
          `${CONFLICT_KEY_PREFIX}${row.work_key}`,
          CONFLICTING_PROGRESS_ON_REPLACEMENT,
          row.work_id,
        );
        continue;
      }
      // The key is unique per generation, so the preparation has to go before the original can
      // take its place. It carried no evidence, no cursor and no attempt: there is nothing in it
      // to keep.
      retire.run(existing.work_id);
    }
    move.run(replacement.replacementGeneration, row.work_id);
    carried += 1;
  }
  return carried;
}

/**
 * Records that a generation's inventory accounts for everything the policy required.
 *
 * The caller supplies the verdict because the verdict is a policy question, and it is refused
 * for any generation that is not the active one. The counter moves with the flag, since a
 * readiness proof taken before an inventory closed was taken against a different answer.
 *
 * Returns the readiness revision, or undefined when the generation is not active and nothing
 * was written.
 */
export function markInventoryComplete(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
  complete: boolean,
): number | undefined {
  return db
    .transaction((): number | undefined => {
      const current = readGeneration(db, sourceId, processingGeneration);
      if (current?.state !== 'active') {
        return undefined;
      }
      if (current.inventoryComplete === complete) {
        return current.operationalRevision;
      }
      const advanced = advanceOperationalRevision(db, sourceId, processingGeneration);
      if (advanced === undefined) {
        return undefined;
      }
      db.prepare(
        `UPDATE source_processing_generations
         SET inventory_complete = ?, inventory_revision = ?
         WHERE source_id = ? AND processing_generation = ?`,
      ).run(complete ? 1 : 0, advanced, sourceId, processingGeneration);
      return advanced;
    })
    .immediate();
}

/**
 * Puts a completed row back to owed, and advances the counter with it.
 *
 * A disposition that rested on a statement about the source stops holding when that statement is
 * withdrawn: an unforgotten source owes again exactly what its forget closed. The outcome is
 * cleared rather than kept beside a pending state, because a row carrying both says two things.
 * Returns the counter's new value, or undefined when the generation is no longer active.
 */
export function reopenSourceWork(
  db: SqliteHandle,
  workId: string,
  reason: string,
  dueAt: Date,
): number | undefined {
  return db
    .transaction((): number | undefined => {
      const row = db
        .prepare(
          'SELECT source_id, processing_generation, state FROM source_work WHERE work_id = ?',
        )
        .get(workId) as
        { source_id: string; processing_generation: number; state: string } | undefined;
      if (row?.state !== 'completed') {
        return undefined;
      }
      const advanced = advanceOperationalRevision(db, row.source_id, row.processing_generation);
      if (advanced === undefined) {
        return undefined;
      }
      db.prepare(
        `UPDATE source_work
         SET state = 'pending', outcome_json = NULL, completed_at = NULL, reason = ?, due_at = ?
         WHERE work_id = ?`,
      ).run(reason.slice(0, 500), dueAt.toISOString(), workId);
      return advanced;
    })
    .immediate();
}

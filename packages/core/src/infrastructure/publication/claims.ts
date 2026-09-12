import { PublicationInvariantError } from './errors.js';
import { parseJson } from './json.js';
import type { PublicationHandler } from './types.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { publicationWrite } from '../sqlite/publication-bounded.js';

/**
 * The two ends of a pre-recovery claim, kept together because neither is safe without the other.
 *
 * Almost no operation declares one. The exception is a request whose whole purpose is to stop
 * another kind: the guard finishes what is already pending before it takes a new request, so a
 * stop that only becomes durable at its own acknowledgment arrives after the thing it was run to
 * prevent. The claim goes down first, and the request's own outcome is what releases it.
 *
 * Both refuse an asynchronous effect for the reason every SQLite hook does: the caller is inside
 * a transaction, and work that escapes it commits somewhere the receipt cannot account for.
 */
function sync(value: unknown, operationId: string): void {
  if (value !== undefined) {
    throw new PublicationInvariantError('async_sqlite_effect', operationId);
  }
}

/** Runs before anything already pending is settled, in its own durable write. */
export function takeClaim(
  db: SqliteHandle,
  handler: PublicationHandler,
  operationId: string,
  payloadJson: string,
): void {
  if (handler.claimBeforeRecovery === undefined) {
    return;
  }
  publicationWrite(db, () => {
    sync(handler.claimBeforeRecovery?.({ db, operationId }, parseJson(payloadJson)), operationId);
  });
}

/** Runs inside the caller's durable write, so the outcome and the release commit together. */
export function releaseClaim(
  db: SqliteHandle,
  handler: PublicationHandler,
  operationId: string,
  payloadJson: string,
): void {
  if (handler.releaseClaim === undefined) {
    return;
  }
  sync(handler.releaseClaim({ db, operationId }, parseJson(payloadJson)), operationId);
}

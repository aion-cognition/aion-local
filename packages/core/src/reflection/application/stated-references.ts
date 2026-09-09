import type { ReflectionProvenance } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import { recordConfirmationFeedback } from './recall-feedback.js';
import {
  confirmationMoment,
  referenceStatementsOf,
  type ReferenceStatements,
} from './reference-statements.js';
import {
  resolveProvenanceTargets,
  writeClaimProvenance,
  type ConfirmationWrite,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import { getLedgerEntry, markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import { hashContent } from '../domain/content.js';

/**
 * What a caller states about other memories: where this experience came from, what it corrects,
 * and who confirmed what. It sits apart from intake because three callers write it and only one
 * of them is a fresh call: intake states it first, the reflection worker re-states whatever the
 * archive holds, and a replay does the same from the row it is re-running.
 */

/**
 * The stated references with their free text redacted, ids untouched.
 *
 * `by` and `evidence` are arbitrary caller text that recall renders back, so they are the same
 * leak surface every other content field is and they go through the same detector. The ids are
 * references to nodes the substrate already holds, and rewriting one would point the reference
 * at nothing, so the walk is scoped to the two text fields rather than run over the block.
 */
export function redactProvenance(
  deps: ProvenanceAttachDeps,
  provenance: ReflectionProvenance | undefined,
  entropyThreshold: number,
): ReflectionProvenance | undefined {
  const confirmations = provenance?.confirmations;
  if (provenance === undefined || confirmations === undefined || confirmations.length === 0) {
    return provenance;
  }
  const redacted = redactPayload(
    confirmations.map((entry) => ({ by: entry.by, evidence: entry.evidence })),
    entropyThreshold,
  );
  if (redacted.matches.length > 0) {
    deps.logger.warn(
      { matches: redacted.matches, count: redacted.matches.length },
      'redacted secrets from stated confirmation evidence',
    );
  }
  return {
    ...provenance,
    confirmations: confirmations.map((entry, index) => ({
      ...entry,
      by: redacted.value[index]?.by ?? entry.by,
      evidence: redacted.value[index]?.evidence ?? entry.evidence,
    })),
  };
}

/** What `attachProvenance` needs, which is far less than the whole intake: replay reuses it. */
export type ProvenanceAttachDeps = {
  readonly driver: Driver;
  readonly logger: Logger;
};

/**
 * The stated references as edges on the episode, once the targets are checked against the
 * substrate. An id nothing resolves is dropped and counted rather than written, so the graph
 * never holds lineage pointing at something that does not exist.
 *
 * Nothing here closes anything. A `supersedes` reference records that somebody holds the target
 * to be wrong; the target keeps its currency, and the supersession judge is still what closes
 * it. A confirmation is recorded the same way: it is evidence beside the claim, and no stage
 * waits on one.
 *
 * Throws when the graph refuses it. The caller decides what that costs: intake swallows it,
 * because the experience is already durable and a failed reference must not fail the write,
 * while the reflection worker lets it fail the integrate job so the queue retries it on the
 * usual backoff. The archive is what makes either survivable: the references are stored with
 * the payload, so the worker, a re-push and `aion replay` all re-state them, and every write
 * here is idempotent, so re-stating changes nothing that already landed.
 *
 * Each confirmation is written under its own moment rather than under this call's: the one the
 * acceptance resolved, or the caller's claim when that is all there is. `now` stands in only when
 * neither exists, so an edge restored by a later pass does not date itself to that pass.
 *
 * Returns the confirmations that resolved, so a caller with the local database can record the
 * signal beside the edge. An unresolvable one is not among them: it was never written.
 */
export async function attachProvenance(
  deps: ProvenanceAttachDeps,
  episodeId: string,
  statements: ReferenceStatements | undefined,
  now: Date,
): Promise<readonly ConfirmationWrite[]> {
  const supersedes = statements?.supersedes ?? [];
  const derivedFrom = statements?.derivedFrom ?? [];
  const confirmations = statements?.confirmations ?? [];
  const named = [...supersedes, ...derivedFrom, ...confirmations.map((entry) => entry.target)];
  if (named.length === 0) {
    return [];
  }

  const resolved = await resolveProvenanceTargets(deps.driver, {
    ids: named,
    mode: withCurrency(now),
  });
  const unresolved = new Set(named.filter((id) => !resolved.has(id))).size;
  const attached: ConfirmationWrite[] = confirmations
    .filter((entry) => resolved.has(entry.target))
    .map((entry) => ({
      target: entry.target,
      by: entry.by,
      evidence: entry.evidence,
      at: confirmationMoment(entry, now),
    }));
  await writeClaimProvenance(deps.driver, {
    episodeId,
    derivedFrom: derivedFrom.filter((id) => resolved.has(id)),
    corrects: supersedes.filter((id) => resolved.has(id)),
    confirmations: attached,
    unresolved,
    now,
  });
  if (unresolved > 0) {
    deps.logger.warn(
      { episodeId, named: named.length, unresolved },
      'reflection named references the substrate does not hold; the lineage is marked incomplete',
    );
  }
  return attached;
}

export type StatedReferenceDeps = ProvenanceAttachDeps & {
  readonly db: SqliteHandle;
};

/**
 * Where an episode's attached reference version is acknowledged.
 *
 * The archive says what the substrate accepted; this says what it managed to write. Without the
 * second half a job cannot tell "already attached" from "never attached", so it either rewrites
 * the same edges on every run or completes over an update nobody made.
 */
export function statedReferenceKey(episodeId: string): string {
  return `stated-references:${episodeId}`;
}

/** One comparable value for what the archive holds, so a later read can tell that it moved. */
function versionOf(references: ReflectionProvenance): string {
  return hashContent(references);
}

function acknowledgedVersion(db: SqliteHandle, episodeId: string): string | undefined {
  const summary = getLedgerEntry(db, statedReferenceKey(episodeId))?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { version } = summary as { version?: unknown };
  return typeof version === 'string' ? version : undefined;
}

/**
 * How many times one call re-reads before it hands the rest back to the queue. A caller adding
 * references faster than the graph accepts them is a queue's problem, not a loop's.
 */
const MAX_SETTLE_PASSES = 3;

/**
 * Whatever the archive holds for this episode, attached and acknowledged.
 *
 * The legacy re-statement path. A source accepted through the acceptance operation records its
 * statements as their own batch and projects them under the guard, so nothing accepted since
 * carries any here. What still does is an archive row written before that split, and the
 * migration that verifies those rows is what re-states them.
 *
 * The archive is the only place a caller's assertion survives a graph that was down when it
 * landed, so this reads from it rather than from the call, and it re-reads after writing: a
 * re-push that added references while the attach was in flight moves the version again, and a
 * completion that compared against nothing would discard the update. When the version will not
 * settle inside the pass bound this throws, which leaves the work to whatever called it: intake
 * logs and lets the queued job carry it, and the worker fails the job into its own backoff. A
 * confirmation the stream refused throws the same way and for the same reason, since the
 * acknowledgement below is what a later pass reads to decide there is nothing left to do.
 *
 * An episode that stated no references costs one archive read. One whose references already
 * landed costs a ledger read on top, and no graph write at all.
 */
export async function settleStatedReferences(
  deps: StatedReferenceDeps,
  episodeId: string,
  now: Date,
): Promise<void> {
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
    const references = getExperienceByEpisode(deps.db, episodeId)?.payload.provenance;
    if (references === undefined) {
      return;
    }
    const version = versionOf(references);
    if (version === acknowledgedVersion(deps.db, episodeId)) {
      return;
    }
    const confirmed = await attachProvenance(
      deps,
      episodeId,
      referenceStatementsOf(references),
      now,
    );
    // Between the edge and the acknowledgement, and it throws rather than warning: a version
    // marked applied over a signal nothing wrote is a signal no later settle ever looks for
    // again. A throw here leaves the episode unacknowledged, so the caller's existing failure
    // path runs the settle again, and every write behind it is keyed on the statement rather
    // than on the attempt.
    recordConfirmationFeedback(deps, episodeId, confirmed);
    markLedgerApplied(deps.db, statedReferenceKey(episodeId), { version });
  }
  throw new Error(`stated references for ${episodeId} changed on every settle pass`);
}

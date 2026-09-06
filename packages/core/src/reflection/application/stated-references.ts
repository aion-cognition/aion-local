import type { ReflectionProvenance } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import {
  resolveProvenanceTargets,
  writeClaimProvenance,
  type ConfirmationWrite,
} from '../../infrastructure/graph/claim-provenance-queries.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import { redactPayload } from '../../redaction/deep-walk.js';

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
 */
export async function attachProvenance(
  deps: ProvenanceAttachDeps,
  episodeId: string,
  provenance: ReflectionProvenance | undefined,
  now: Date,
): Promise<void> {
  const supersedes = provenance?.supersedes ?? [];
  const derivedFrom = provenance?.derived_from ?? [];
  const confirmations = provenance?.confirmations ?? [];
  const named = [...supersedes, ...derivedFrom, ...confirmations.map((entry) => entry.target)];
  if (named.length === 0) {
    return;
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
      at: entry.occurred_at === undefined ? now : new Date(entry.occurred_at),
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
}

/**
 * The references this episode is known to have accepted, re-stated from the archive rather than
 * from the call: the worker runs long after the call returned, and the archive is the only place
 * a caller's assertion survives a graph that was down when it landed.
 *
 * Every write behind it is idempotent, so an episode whose references already landed pays one
 * archive read and nothing else. A graph still refusing throws, and the caller decides.
 */
export async function repairStatedReferences(
  deps: ProvenanceAttachDeps & { readonly db: SqliteHandle },
  episodeId: string,
  now: Date,
): Promise<void> {
  const references = getExperienceByEpisode(deps.db, episodeId)?.payload.provenance;
  if (references === undefined) {
    return;
  }
  await attachProvenance(deps, episodeId, references, now);
}

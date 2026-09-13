import { z } from 'zod';

import { advanceNodeState } from '../../evidence/application/node-state.js';
import { supersedeInTransaction } from '../../infrastructure/graph/bitemporal.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import {
  standingFamilyNodesInTransaction,
  standsInFamilyInTransaction,
} from '../../infrastructure/graph/narrative-cleanup-queries.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { narrativeRevisionBinding } from '../../infrastructure/sqlite/chunk-manifest.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listAcknowledgedRevisions } from '../../infrastructure/sqlite/narrative-allocations.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';

/**
 * The repair for a narrative family whose graph currency disagrees with its own manifest.
 *
 * A publication acknowledges the next revision and closes the head it replaced; a crash between
 * the graph write and that close leaves both nodes standing while the manifest already says which
 * one is the head. The manifest is right and the graph is behind, so this writes no output and
 * allocates no revision: it makes the graph agree with a decision that was already taken.
 *
 * It goes through the coordinator for the reason every other semantic write does. The head it
 * closes against is a fact another writer can move, and a repair holding a node lock while the
 * publication that moves that head runs beside it would close a revision against a keeper that is
 * no longer the keeper. Inheriting a raw graph transaction from the sweep that nominated the
 * family fences nothing: the guard is what serializes this against the publication path, and the
 * receipt is what makes an interrupted repair recoverable rather than repeated.
 *
 * What it will not touch: a revision the manifest still calls allocated or prepared. That is an
 * attempt in flight, its output is recovered by its own receipt, and suppressing its node here
 * would destroy the thing the recovery is for.
 *
 * How much it may look at is decided before the guard is taken. The caller names the window of the
 * family's history this attempt reads, and everything inside it is re-read and re-decided here —
 * the window bounds the work, and the records still decide the outcome.
 */

export const NARRATIVE_FAMILY_REPAIR_EFFECT = 'narrative_family_repaired';

const REPAIR_SIGNALS = ['duplicate_narrative'];
const REPAIR_PROVENANCE = ['introspection_narrative_duplicate'];

/** States in which a revision node is an acknowledged version rather than an attempt in flight. */
const ACKNOWLEDGED_STATES = new Set(['published', 'closed']);

/**
 * Revision nodes one repair closes. A family carrying more standing versions than this is
 * repaired across runs rather than in one unbounded write.
 */
export const REPAIR_TARGET_LIMIT = 32;

/**
 * Candidate revision records ONE guarded preparation reads. A total, not a page.
 *
 * Two bounds were tried and neither held. A scan over the family's standing GRAPH nodes spent its
 * budget on whatever ids sorted first, so a page of ids the manifest binds to nothing hid the
 * legitimate target behind it on every run. Reading candidates from the records removed that
 * prefix but bounded each page rather than the work: a family's lifetime history has no configured
 * maximum, so a long one read all of it inside a single preparation, under the guard, serialized
 * against every other writer.
 *
 * This is the whole read. The window it covers is chosen OUTSIDE the guard by the nomination that
 * asked for the repair, which carries its own position down the family across attempts, so a
 * target below one window is reached by a later attempt rather than by a longer one.
 */
export const REPAIR_SCAN_LIMIT = 128;

const Payload = z.strictObject({
  chunkId: z.string().min(1),
  /** The caller's own epoch, so a registry that moved defers this rather than being re-read. */
  coverageEpoch: z.string().min(1),
  observedAt: z.string().min(1),
  /**
   * The nominated window: acknowledged revisions BELOW this number. Omitted starts at the head,
   * which is where the disagreement is made and where an unbounded walk would have begun anyway.
   * The window is a bound on the read, never a licence: what may be closed inside it is decided
   * under the guard from the records, exactly as before.
   */
  beforeRevisionNo: z.number().int().positive().optional(),
});

const Data = Payload.extend({
  headNodeId: z.string().min(1),
  headRevisionNo: z.number().int().positive(),
  targets: z.array(z.string().min(1)),
  /** Every standing revision node this repair read, the keeper included. */
  examined: z.number().int().nonnegative(),
  /**
   * Candidate records read to produce that. A different unit from `examined`, which counts what
   * the graph reported standing, and from the nomination's own family/version counts. Plans
   * written before the manifest-driven selection counted a third population again and are not
   * comparable with either.
   */
  candidates: z.number().int().nonnegative(),
});

const Result = z.strictObject({
  closed: z.number().int().nonnegative(),
  closedEdges: z.number().int().nonnegative(),
});

type RepairData = z.infer<typeof Data>;

/** The operation identity one repair attempt takes, so its receipt is its own. */
export function narrativeFamilyRepairOperationId(chunkId: string, at: Date): string {
  return `narrative-family-repair:${chunkId}:${at.toISOString()}`;
}

/** Whether the manifest calls this node an acknowledged revision of THIS family. */
function repairable(db: SqliteHandle, chunkId: string, nodeId: string): boolean {
  const binding = narrativeRevisionBinding(db, nodeId);
  return (
    binding?.family === 'chunk' &&
    binding.familyKey === chunkId &&
    ACKNOWLEDGED_STATES.has(binding.state)
  );
}

/**
 * Standing nodes this repair may close, selected from the records rather than found in the graph.
 *
 * The candidates are one bounded window of the family's own acknowledged revisions, and the graph
 * is asked once which of those still stand. That is the direction the two stores can each answer:
 * the manifest is the authority on which nodes are revisions of this family, and the graph is the
 * authority on which nodes are current. Asking the graph first spent the bound on whatever ids
 * sorted first, so a page of ids the manifest binds to nothing hid the legitimate target behind
 * them — a cursor over FAMILIES cannot step inside one.
 *
 * Both endpoints of every close are still checked against the manifest family, so an id the
 * records have stopped binding between the two reads is not this family's to close.
 *
 * Three bounds, all on one attempt: `REPAIR_SCAN_LIMIT` candidate records, one graph read, and
 * `REPAIR_TARGET_LIMIT` targets written. Nothing here loops, so no bound is renewable inside the
 * guard; reaching further down a long family is the nomination's job.
 */
async function repairableTargets(
  context: { readonly graph: GraphTransaction; readonly db: SqliteHandle },
  chunkId: string,
  keeperNodeId: string,
  before: number | undefined,
): Promise<{ targets: string[]; examined: number; candidates: number }> {
  const window = listAcknowledgedRevisions(
    context.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    REPAIR_SCAN_LIMIT,
    before,
  );
  const standing = await standingFamilyNodesInTransaction(
    context.graph,
    chunkId,
    window.map((row) => row.nodeId),
  );
  const targets: string[] = [];
  for (const row of window) {
    if (targets.length >= REPAIR_TARGET_LIMIT) {
      break;
    }
    if (
      standing.has(row.nodeId) &&
      row.nodeId !== keeperNodeId &&
      repairable(context.db, chunkId, row.nodeId)
    ) {
      targets.push(row.nodeId);
    }
  }
  return { targets, examined: standing.size, candidates: window.length };
}

export const narrativeFamilyRepairPublication = new PublicationOperation({
  kind: 'narrative_family_repair',
  effectKinds: [NARRATIVE_FAMILY_REPAIR_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('a narrative family cannot be repaired before the coverage registry exists');
    }
    const head = readPublishedRevision(context.db, CHUNK_REVISION_FAMILY, payload.chunkId);
    // The keeper has to be STANDING, not merely named by the manifest. A head something else
    // closed in the graph is not a keeper: closing the survivors onto it would leave the family
    // with no current narrative at all, which is the one outcome this repair exists to prevent.
    // It is proved by its own name, not by turning up in a page of the family's other ids.
    const keeper =
      head !== undefined &&
      (await standsInFamilyInTransaction(context.graph, payload.chunkId, head.nodeId))
        ? head
        : undefined;
    const found =
      keeper === undefined
        ? { targets: [], examined: 0, candidates: 0 }
        : await repairableTargets(
            context,
            payload.chunkId,
            keeper.nodeId,
            payload.beforeRevisionNo,
          );
    const data: RepairData = {
      ...payload,
      headNodeId: keeper?.nodeId ?? '',
      headRevisionNo: head?.revisionNo ?? 1,
      targets: found.targets,
      examined: found.examined,
      candidates: found.candidates,
    };
    return {
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        // The head the graph is being made to agree with. A publication landing between this and
        // the write moves it, and the recheck below refuses rather than closing against a keeper
        // that has stopped being one.
        heads: [{ chunkId: payload.chunkId, publishedRevisionNo: head?.revisionNo ?? null }],
      },
      scopes: [],
      effects: [
        {
          kind: NARRATIVE_FAMILY_REPAIR_EFFECT,
          detail: {
            chunkId: payload.chunkId,
            targets: found.targets.length,
            candidates: found.candidates,
          },
        },
      ],
    };
  },
  check(context, data, expected) {
    const head = readPublishedRevision(context.db, CHUNK_REVISION_FAMILY, data.chunkId);
    if (head === undefined || data.headNodeId === '') {
      // Nothing of this family has been acknowledged, so there is no keeper to close against and
      // the standing nodes are somebody else's attempt in flight.
      return Promise.resolve({ status: 'rejected', reason: 'family_head_absent' } as const);
    }
    if (head.revisionNo !== (expected.heads[0]?.publishedRevisionNo ?? null)) {
      return Promise.resolve({ status: 'deferred', reason: 'head_moved' } as const);
    }
    if (head.nodeId !== data.headNodeId) {
      return Promise.resolve({ status: 'deferred', reason: 'head_moved' } as const);
    }
    if (data.headNodeId === '' || data.targets.length === 0) {
      return Promise.resolve({ status: 'rejected', reason: 'nothing_to_repair' } as const);
    }
    for (const nodeId of data.targets) {
      if (!repairable(context.db, data.chunkId, nodeId)) {
        return Promise.resolve({ status: 'deferred', reason: 'target_state_moved' } as const);
      }
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context, data: RepairData): Promise<z.infer<typeof Result>> {
    const { now } = context;
    const validUntil = new Date(data.observedAt);
    for (const nodeId of data.targets) {
      await supersedeInTransaction(context.graph, {
        oldId: nodeId,
        newId: data.headNodeId,
        now,
        validUntil,
        signals: REPAIR_SIGNALS,
        provenance: REPAIR_PROVENANCE,
      });
    }
    // The members' own traversal edges into the closed revisions, in the same transaction. A
    // close that left them open would leave every source underneath still walking to a narrative
    // the substrate has stopped standing behind.
    const closed = await closeNarrativeEdgesInTransaction(context.graph, {
      narrativeIds: data.targets,
      validUntil,
      txUntil: now,
    });
    return { closed: data.targets.length, closedEdges: closed.length };
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    // Closing a node is a change to its own semantic state, so evidence somebody else is holding
    // about that state stops being current HERE, in the operation that made the change. Left
    // alone, a judgment fenced on the reading this repair invalidated would still verify as
    // current against a narrative the substrate has stopped standing behind.
    //
    // The manifest itself does not move — it already named this head and already called these
    // revisions closed, which is the disagreement being repaired — so the mirrors and the
    // receipt are the whole durable record of the repair.
    for (const nodeId of data.targets) {
      advanceNodeState(context.db, nodeId, context.operationId, context.knownFrom);
    }
    return undefined;
  },
  discardSqlite() {
    return undefined;
  },
});

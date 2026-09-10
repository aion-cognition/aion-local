import type { Driver } from 'neo4j-driver';

import type { NarrativeMaintenanceDeps } from './narrative-seal.js';
import { certifyNarrativeSupport } from '../../../evidence/application/narrative-support.js';
import {
  findDuplicateChunkFamilies,
  findDuplicateNarrativeSessions,
  findOrphanedNarratives,
} from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import {
  closeStaleNarrativeEdges,
  countNarrativeEdges,
} from '../../../infrastructure/graph/narrative-edge-queries.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { narrativeFamilyRepairOperationId } from '../../../reflection/application/narrative-repair.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * The narrative pathologies that need no model call to repair, and the two that turned out not to
 * be pathologies at all.
 *
 * An extra standing revision of ONE chunk is a crash between a publication and the close of the
 * head it replaced, and closing it is arithmetic: the manifest says which revision the substrate
 * acknowledged, so the keeper is read rather than chosen. What used to be grouped here was the
 * SESSION, which made two distinct chunks of one conversation duplicates of each other and picked
 * the survivor by coverage count — prose beating the record.
 *
 * The orphan repair is now a report. A narrative whose session holds no live Episode was treated
 * as ungrounded and forgotten, which deleted the compressed record of exactly the sessions whose
 * raw containers had been evicted. Eviction is storage and support is evidence: what holds a
 * narrative up is its frozen membership and its citations, both of which outlive the raw text.
 * Where the records prove support the narrative stands; where they prove nothing the run withholds
 * and says so, because a suppression has no reopen path and silence is not absence.
 *
 * The third repair is unchanged: the summarization-edge backlog, bounded per run and idempotent.
 *
 * The grounding-stale regeneration path (`reflection/application/narrative-cleanup.ts`) is out of
 * scope here because it calls a model to rewrite the narrative body. `narrative_regrounding` is
 * the operation that drives that path.
 */

export const NARRATIVE_CLEANUP_OPERATION = 'narrative_cleanup';

export const NARRATIVE_DUPLICATE_METHOD = 'introspection_narrative_duplicate';

/**
 * Standing relevance, like `memory_decay`: neither pathology this operation repairs has a
 * live gauge in the snapshot (the graph collector's `staleNarratives` counts a different
 * thing, the grounding-revision backlog this operation does not touch), so it reaches the
 * urgency threshold on waiting time, the same "scheduled cadence" memory_decay documents.
 * Wiring it to `staleNarratives` anyway would make the engine expect a count this operation
 * cannot move, and score every run against a metric it never had a hand in.
 */
export const NARRATIVE_CLEANUP_STANDING_RELEVANCE = 0.15;

/**
 * Revision records one run reads across every family it visits.
 *
 * The bound the family limit gives is a bound on GROUPS, and one group can carry any number of
 * standing versions, so a run bounded only by families does unbounded per-record work. This is
 * the term the run reports as examined, which is what makes the two numbers comparable.
 */
const REVISION_SCAN_BUDGET = 200;

type DuplicateReport = {
  readonly families: number;
  /** Revision records this run actually read, keeper included: the denominator of its closes. */
  readonly examined: number;
  readonly closed: number;
  /** Traversal edges the repair closed with the revisions it superseded. */
  readonly closedEdges: number;
  /** Families whose keeper the records could not name, left standing and reported. */
  readonly unresolved: number;
  /** Legacy session families carrying more than one standing narrative. */
  readonly legacy: number;
};

/**
 * Closes the extra acknowledged revisions of one chunk against the head the manifest names.
 *
 * The scan nominates and the coordinator decides. What the graph shows is a claim about a moment
 * that has passed: the head this close is taken against is a fact another writer can move, so the
 * repair is published like every other semantic write, rechecked under the guard, and recorded
 * with a receipt that makes an interrupted one recoverable rather than repeated.
 *
 * Three things it still does not do. It does not choose a keeper: the acknowledged head is read
 * inside the guard. It does not touch a revision the manifest calls allocated or prepared: that
 * is an attempt in flight, recovered by its own receipt. And it does not act where nothing of the
 * family has been acknowledged, because then there is no keeper to close anything against.
 */
async function closeExtraRevisions(
  ctx: OperationContext,
  publications: NarrativeMaintenanceDeps['publications'],
  limit: number,
): Promise<{
  families: number;
  examined: number;
  closed: number;
  closedEdges: number;
  unresolved: number;
}> {
  // The per-family version bound distributes the run's record budget across the families the
  // page may return, so the page cannot materialize more records than the run may examine.
  const versionLimit = Math.max(2, Math.floor(REVISION_SCAN_BUDGET / Math.max(1, limit)));
  const cursor = readRepairCursor(ctx.db);
  let families = await findDuplicateChunkFamilies(ctx.driver, {
    limit,
    versionLimit,
    ...(cursor === undefined ? {} : { after: cursor }),
  });
  if (families.length === 0 && cursor !== undefined) {
    // The end of the enumeration, reached inside this run rather than costing one. Starting again
    // from the front is what makes the cursor a position and not a discharge: a family an earlier
    // page could not repair is visited again, and a run that resumed near the tail still spends
    // its page.
    families = await findDuplicateChunkFamilies(ctx.driver, { limit, versionLimit });
  }
  const epoch = readCurrentCoverageContract(ctx.db)?.epoch;
  if (epoch === undefined) {
    return {
      families: families.length,
      examined: 0,
      closed: 0,
      closedEdges: 0,
      unresolved: families.length,
    };
  }
  let examined = 0;
  let closed = 0;
  let closedEdges = 0;
  let unresolved = 0;
  for (const family of families) {
    if (examined >= REVISION_SCAN_BUDGET) {
      // The family bound is not a write bound. One family can carry any number of standing
      // versions, so a run bounded only by families is bounded by nothing per record; the ones
      // this run does not reach are still there for the next.
      break;
    }
    const outcome = await publications
      .publish({
        kind: 'narrative_family_repair',
        operationId: narrativeFamilyRepairOperationId(family.chunkId, ctx.now),
        payload: {
          chunkId: family.chunkId,
          coverageEpoch: epoch,
          observedAt: ctx.now.toISOString(),
        },
      })
      .catch((err: unknown) => {
        ctx.logger.warn(
          { err, chunkId: family.chunkId },
          'narrative family repair could not publish; the family stays as it is',
        );
        return undefined;
      });
    examined += family.versions.length;
    if (outcome?.status !== 'acknowledged') {
      if (outcome !== undefined) {
        ctx.logger.info(
          { chunkId: family.chunkId, status: outcome.status, reason: outcome.reason },
          'narrative family repair did not land',
        );
      }
      unresolved += 1;
      continue;
    }
    // Both effects, from the producer that performed them. The repair closes a revision AND the
    // traversal edges into it, in one transaction; the later stale-edge sweep cannot count those
    // edges, because by the time it runs they are already closed. Reporting only the revision
    // credited the run with a third of what it did.
    const result = outcome.result as { closed?: number; closedEdges?: number };
    closed += result.closed ?? 0;
    closedEdges += result.closedEdges ?? 0;
  }
  // Where this page stopped. A family it could not repair is behind the cursor rather than at the
  // front of every later page, and the cursor settles nothing: it wraps at the end of the walk.
  writeRepairCursor(ctx.db, families[families.length - 1]?.chunkId);
  return { families: families.length, examined, closed, closedEdges, unresolved };
}

/** Where the last run's family nomination stopped. One row, naming a family and nothing else. */
const REPAIR_CURSOR_KEY = 'narrative_cleanup:family_cursor';

function readRepairCursor(db: SqliteHandle): string | undefined {
  const summary = getLedgerEntry(db, REPAIR_CURSOR_KEY)?.summary;
  if (typeof summary !== 'object' || summary === null) {
    return undefined;
  }
  const { chunkId } = summary as { chunkId?: unknown };
  return typeof chunkId === 'string' && chunkId !== '' ? chunkId : undefined;
}

function writeRepairCursor(db: SqliteHandle, chunkId: string | undefined): void {
  markLedgerApplied(db, REPAIR_CURSOR_KEY, chunkId === undefined ? {} : { chunkId });
}

/**
 * Narratives the structural scan nominates, and what the records say about each.
 *
 * The no-Episode read stays as a cheap NOMINATION and is no longer the decision: it says which
 * narratives are worth asking about, and the manifest says whether anything holds them up. A
 * chunk revision over evicted sources answers `supported` on its frozen membership and is left
 * exactly as it is; a legacy narrative the manifest never bound answers `unbound`, which is a
 * repair obligation rather than a licence, so nothing here forgets it.
 */
function certifyNominated(
  db: SqliteHandle,
  ids: readonly string[],
): { supported: number; withheld: number } {
  let supported = 0;
  let withheld = 0;
  for (const id of ids) {
    if (certifyNarrativeSupport(db, id).support === 'supported') {
      supported += 1;
      continue;
    }
    withheld += 1;
  }
  return { supported, withheld };
}

/**
 * The backlog measured before it is touched, so the detail line reports the whole residue
 * against what one batch reached, and reports active fan-out beside it. The two numbers are
 * separate on purpose: physical edge count says nothing about how much of the graph a
 * traversal can actually walk, and only the active half is the fan-out recall pays for.
 *
 * `examined` is the population this pass actually read, which is not the backlog. The bounded
 * statement matches at most `batch` rows and writes every row it matched, so what it examined
 * and what it changed are the same set by construction. The backlog is a gauge that belongs
 * beside them and never inside them.
 */
async function repairSummarizationEdges(
  driver: Driver,
  batch: number,
  now: Date,
): Promise<{ backlog: number; active: number; examined: number; closed: number }> {
  const before = await countNarrativeEdges(driver);
  const closed = await closeStaleNarrativeEdges(driver, { batchSize: batch, now });
  return {
    backlog: before.stale,
    active: before.active,
    examined: closed.length,
    closed: closed.length,
  };
}

export function narrativeCleanupOperation(): IntrospectionOperation {
  return {
    name: NARRATIVE_CLEANUP_OPERATION,
    bucket: 'hour',
    relevance: () => NARRATIVE_CLEANUP_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const batch = ctx.config.maintenance.narrativeCleanupBatch;
      const chunks =
        ctx.narratives === undefined
          ? { families: 0, examined: 0, closed: 0, closedEdges: 0, unresolved: 0 }
          : await closeExtraRevisions(ctx, ctx.narratives.publications, batch);
      // The legacy family is counted and left alone. Its keeper cannot be read from a manifest
      // that never bound it, and the signed rule is explicit that a winner is not picked by
      // coverage, prose or graph timestamp; reconciling the preserved coverage and citation
      // records is the cutover's work, not a sweep's.
      const legacy = await findDuplicateNarrativeSessions(ctx.driver, batch);
      const duplicates: DuplicateReport = { ...chunks, legacy: legacy.length };

      const nominated = await findOrphanedNarratives(ctx.driver, batch);
      const support = certifyNominated(
        ctx.db,
        nominated.map((orphan) => orphan.id),
      );

      // Last, so the closes above are part of the backlog this run already repairs.
      const edges = await repairSummarizationEdges(
        ctx.driver,
        ctx.config.maintenance.narrativeEdgeRepairBatch,
        ctx.now,
      );

      // The stale-edge BACKLOG used to stand in for the edge term too, which made a run that
      // closed five hundred of forty thousand report forty thousand examined and a vanishing
      // effect ratio. The backlog is a gauge in the detail; the subtallies are what adds up.
      // One declared unit: a record this run READ and could have changed. The duplicate term is
      // the revision records the NOMINATION returned — which is the population the run reads, and
      // the population R1's bound is enforced over — while the affected term is what the repair's
      // own result says it changed.
      // Both record classes on both sides. The repair reads revision records and the traversal
      // edges into the ones it closes, and it changes both; counting the edges as affected while
      // leaving them out of examined would make the two terms incomparable in the other
      // direction. The edge population it read and the one it changed are the same set, for the
      // reason the stale-edge sweep's are: the statement matches what it writes.
      const processed =
        duplicates.examined + duplicates.closedEdges + nominated.length + edges.examined;
      const affected = duplicates.closed + duplicates.closedEdges + edges.closed;
      return {
        status: affected === 0 ? 'noop' : 'applied',
        itemsProcessed: processed,
        itemsAffected: affected,
        detail:
          `examined ${String(duplicates.examined)} revision record(s) and ` +
          `${String(duplicates.closedEdges)} traversal edge(s) across ` +
          `${String(duplicates.families)} chunk family/families, ` +
          `${String(nominated.length)} nominated narrative(s), ` +
          `${String(edges.examined)} stale edge(s); ` +
          `${String(duplicates.closed)} extra revision(s) superseded onto the acknowledged head ` +
          `with ${String(duplicates.closedEdges)} traversal edge(s), ` +
          `${String(duplicates.unresolved)} family/families with no acknowledged head, ` +
          `${String(duplicates.legacy)} legacy session family/families reported, ` +
          `${String(support.supported)} narrative(s) the records hold up, ` +
          `${String(support.withheld)} withheld for want of proof, ` +
          `${String(edges.closed)} stale summarization edge(s) closed; ` +
          `backlog ${String(edges.backlog)} stale, ${String(edges.active)} active`,
      };
    },
  };
}

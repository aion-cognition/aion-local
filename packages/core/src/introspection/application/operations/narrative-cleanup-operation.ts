import type { Driver } from 'neo4j-driver';

import { certifyNarrativeSupport } from '../../../evidence/application/narrative-support.js';
import { supersedeInTransaction } from '../../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../../infrastructure/graph/connection.js';
import { lockNodeInTransaction } from '../../../infrastructure/graph/locks.js';
import {
  findDuplicateChunkFamilies,
  findDuplicateNarrativeSessions,
  findOrphanedNarratives,
  readOpenChunkRevisionsInTransaction,
} from '../../../infrastructure/graph/narrative-cleanup-queries.js';
import {
  closeStaleNarrativeEdges,
  countNarrativeEdges,
} from '../../../infrastructure/graph/narrative-edge-queries.js';
import { narrativeRevisionBinding } from '../../../infrastructure/sqlite/chunk-manifest.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  CHUNK_REVISION_FAMILY,
  readPublishedRevision,
} from '../../../infrastructure/sqlite/narrative-revisions.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

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
const NARRATIVE_DUPLICATE_SIGNALS = ['duplicate_narrative'];

/**
 * Standing relevance, like `memory_decay`: neither pathology this operation repairs has a
 * live gauge in the snapshot (the graph collector's `staleNarratives` counts a different
 * thing, the grounding-revision backlog this operation does not touch), so it reaches the
 * urgency threshold on waiting time, the same "scheduled cadence" memory_decay documents.
 * Wiring it to `staleNarratives` anyway would make the engine expect a count this operation
 * cannot move, and score every run against a metric it never had a hand in.
 */
export const NARRATIVE_CLEANUP_STANDING_RELEVANCE = 0.15;

/** States in which a revision node is an acknowledged version rather than an attempt in flight. */
const ACKNOWLEDGED_STATES = new Set(['published', 'closed']);

type DuplicateReport = {
  readonly families: number;
  readonly closed: number;
  /** Families whose keeper the records could not name, left standing and reported. */
  readonly unresolved: number;
  /** Legacy session families carrying more than one standing narrative. */
  readonly legacy: number;
};

/**
 * Closes the extra acknowledged revisions of one chunk against the head the manifest names.
 *
 * Three things this deliberately does not do. It does not choose a keeper: the published head is
 * read inside the write, so a publication landing between the scan and the close moves the keeper
 * rather than losing to it. It does not touch a revision the manifest still calls allocated or
 * prepared: that is an attempt in flight, and it is recovered by its own receipt rather than
 * suppressed as unwanted. And it does not act at all where no revision of the family has been
 * acknowledged, because then there is no keeper to close anything against.
 */
async function closeExtraRevisions(
  driver: Driver,
  db: SqliteHandle,
  limit: number,
  now: Date,
): Promise<{ families: number; closed: number; unresolved: number }> {
  const families = await findDuplicateChunkFamilies(driver, limit);
  let closed = 0;
  let unresolved = 0;
  for (const family of families) {
    const outcome = await inWriteTransaction(driver, async (tx) => {
      const head = readPublishedRevision(db, CHUNK_REVISION_FAMILY, family.chunkId);
      if (head === undefined) {
        return { closed: 0, resolved: false };
      }
      await lockNodeInTransaction(tx, head.nodeId, now);
      const versions = await readOpenChunkRevisionsInTransaction(tx, family.chunkId);
      if (!versions.some((version) => version.id === head.nodeId)) {
        // The head itself is not standing. Something other than this sweep is mid-flight on the
        // family, and closing the rest against an absent keeper would leave the chunk with no
        // current narrative at all.
        return { closed: 0, resolved: false };
      }
      let here = 0;
      for (const version of versions) {
        if (version.id === head.nodeId) {
          continue;
        }
        const binding = narrativeRevisionBinding(db, version.id);
        if (binding === undefined || !ACKNOWLEDGED_STATES.has(binding.state)) {
          continue;
        }
        await supersedeInTransaction(tx, {
          oldId: version.id,
          newId: head.nodeId,
          now,
          signals: NARRATIVE_DUPLICATE_SIGNALS,
          provenance: [NARRATIVE_DUPLICATE_METHOD],
        });
        here += 1;
      }
      return { closed: here, resolved: true };
    });
    closed += outcome.closed;
    if (!outcome.resolved) {
      unresolved += 1;
    }
  }
  return { families: families.length, closed, unresolved };
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
      const chunks = await closeExtraRevisions(ctx.driver, ctx.db, batch, ctx.now);
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

      // One declared unit across the repairs: a record this run READ and could have changed. The
      // stale-edge BACKLOG used to stand in for the edge term, which made a run that closed five
      // hundred of forty thousand report forty thousand examined and a vanishing effect ratio.
      // The backlog is a gauge in the detail; the subtallies are what a reader adds up.
      const processed = duplicates.families + nominated.length + edges.examined;
      const affected = duplicates.closed + edges.closed;
      return {
        status: affected === 0 ? 'noop' : 'applied',
        itemsProcessed: processed,
        itemsAffected: affected,
        detail:
          `examined ${String(duplicates.families)} chunk family/families, ` +
          `${String(nominated.length)} nominated narrative(s), ` +
          `${String(edges.examined)} stale edge(s); ` +
          `${String(duplicates.closed)} extra revision(s) superseded onto the acknowledged head, ` +
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

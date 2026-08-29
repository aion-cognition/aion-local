import type { IntrospectionOperation } from '../domain/operation.js';
import { communityRefreshOperation } from './operations/community-refresh.js';
import { deadLetterOperation } from './operations/dead-letter.js';
import { descriptionFreshnessOperation } from './operations/description-freshness-operation.js';
import { narrativeCleanupOperation } from './operations/narrative-cleanup-operation.js';
import { orphanCleanupOperation } from './operations/orphan-cleanup.js';
import { reconcileReenqueueOperation } from './operations/reconcile-reenqueue.js';
import { redactionResiduePurgeOperation } from './operations/redaction-residue-purge.js';
import { retroJudgmentSweepOperation } from './operations/retro-judgment-sweep-operation.js';
import { symbiosisBridgeOperation } from './operations/symbiosis-bridge.js';
import { vectorBackfillOperation } from './operations/vector-backfill.js';
import { memoryDecayOperation, reinforcementFlushOperation } from './plasticity-operations.js';

/**
 * The registration seam: the one list the service hands the engine. An operation joins
 * maintenance by being constructed here and nowhere else, so what the loop can run is
 * readable in a single function instead of assembled across a wiring file.
 *
 * Order is documentation, not priority. Selection is by tier and urgency, and ties break on
 * waiting time and then on name, so moving a line here changes nothing about what runs.
 *
 * The four substrate-hygiene operations (`vector_backfill`, `reconcile_reenqueue`,
 * `dead_letter`, `redaction_residue_purge`) were added together: each answers a gap in
 * `aion doctor`'s own checks, where the check could name the problem but nothing closed it.
 */
export function introspectionOperations(): readonly IntrospectionOperation[] {
  return [
    reinforcementFlushOperation(),
    memoryDecayOperation(),
    vectorBackfillOperation(),
    reconcileReenqueueOperation(),
    deadLetterOperation(),
    redactionResiduePurgeOperation(),
    // The content-maintenance set (P5-1c): narrative cleanup, the retro supersession
    // backlog sweep, and entity description freshness. Appended after the structural set
    // above for no reason beyond arrival order; selection does not read this list's order.
    narrativeCleanupOperation(),
    retroJudgmentSweepOperation(),
    descriptionFreshnessOperation(),
    // The graph-topology set: repair connectivity, then re-derive the neighbourhoods, then
    // join the two the graph connects least. Registered in that order because it is the order
    // they depend on each other, not because the engine reads it.
    orphanCleanupOperation(),
    communityRefreshOperation(),
    symbiosisBridgeOperation(),
  ];
}

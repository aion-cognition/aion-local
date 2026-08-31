import type { IntrospectionOperation } from '../domain/operation.js';
import { backboneRepairOperation } from './operations/backbone-repair.js';
import { communityRefreshOperation } from './operations/community-refresh.js';
import { deadLetterOperation } from './operations/dead-letter.js';
import { descriptionFreshnessOperation } from './operations/description-freshness-operation.js';
import { edgePruneOperation } from './operations/edge-prune.js';
import { identifierDecayOperation } from './operations/identifier-decay.js';
import { mergeAutoOperation } from './operations/merge-auto-operation.js';
import { narrativeCleanupOperation } from './operations/narrative-cleanup-operation.js';
import { narrativeRegroundingOperation } from './operations/narrative-regrounding.js';
import { orphanCleanupOperation } from './operations/orphan-cleanup.js';
import { proposalHygieneOperation } from './operations/proposal-hygiene.js';
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
 * waiting time and then on name, so moving a line here changes nothing about what runs. The
 * first four groups read outward from the substrate: what makes a node findable at all, then
 * what makes the edges between nodes carry weight, then what the nodes say, then the shape the
 * whole graph has taken. The last group stands apart: it repairs nothing, it only watches.
 */
export function introspectionOperations(): readonly IntrospectionOperation[] {
  return [
    // Substrate hygiene. Each of these answers a gap `aion doctor` could already name and
    // nothing could close: a node with no vector is invisible to search, an episode with no
    // ledger key and no queue row is never enriched, an exhausted job blocks its own lane, and
    // a redaction that landed after the write leaves the secret in the graph.
    vectorBackfillOperation(),
    reconcileReenqueueOperation(),
    deadLetterOperation(),
    redactionResiduePurgeOperation(),

    // Plasticity: the two bounded weight operations, on the loop's clock rather than a
    // caller's, then the sweep that closes what decay's own floor clamp leaves traversable
    // in name only.
    reinforcementFlushOperation(),
    memoryDecayOperation(),
    edgePruneOperation(),
    identifierDecayOperation(),

    // Content maintenance: duplicate narratives, narratives whose claims a correction has since
    // closed, the contradiction backlog older than the supersession stage, and entity glosses
    // that stopped describing what the entity became.
    narrativeCleanupOperation(),
    narrativeRegroundingOperation(),
    retroJudgmentSweepOperation(),
    descriptionFreshnessOperation(),

    // Topology: repair connectivity, then re-derive the neighbourhoods, then join the two the
    // graph connects least. Listed in that order because it is the order they depend on each
    // other, not because the engine reads it.
    backboneRepairOperation(),
    orphanCleanupOperation(),
    communityRefreshOperation(),
    symbiosisBridgeOperation(),

    // Entity-merge policy: merges the exact-name pairs a person going on to approve every one
    // of, measured over two live review batches, already proved safe. A fuzzy pair passes
    // through untouched and stays queued for `aion proposals`.
    mergeAutoOperation(),

    // The queue's own hygiene: ages a proposal out once nobody has acted on it inside its
    // horizon, ledgered and reversible with `aion proposals reopen`.
    proposalHygieneOperation(),
  ];
}

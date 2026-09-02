import type { IntrospectionOperation } from '../domain/operation.js';
import { backboneRepairOperation } from './operations/backbone-repair.js';
import { claimConsolidationOperation } from './operations/claim-consolidation.js';
import { claimDedupOperation } from './operations/claim-dedup.js';
import { communityRefreshOperation } from './operations/community-refresh.js';
import { deadLetterOperation } from './operations/dead-letter.js';
import { descriptionFreshnessOperation } from './operations/description-freshness-operation.js';
import { edgePruneOperation } from './operations/edge-prune.js';
import { identifierDecayOperation } from './operations/identifier-decay.js';
import { mergeAutoOperation } from './operations/merge-auto-operation.js';
import { mergeDecisionReconcileOperation } from './operations/merge-decision-reconcile-operation.js';
import { narrativeCleanupOperation } from './operations/narrative-cleanup-operation.js';
import { narrativeRegroundingOperation } from './operations/narrative-regrounding.js';
import {
  dayNarrativeRollupOperation,
  weekNarrativeRollupOperation,
} from './operations/narrative-rollup.js';
import { orphanCleanupOperation } from './operations/orphan-cleanup.js';
import { proposalHygieneOperation } from './operations/proposal-hygiene.js';
import { reconcileReenqueueOperation } from './operations/reconcile-reenqueue.js';
import { redactionResiduePurgeOperation } from './operations/redaction-residue-purge.js';
import { retroJudgmentSweepOperation } from './operations/retro-judgment-sweep-operation.js';
import { structuralDiscoveryOperation } from './operations/structural-discovery.js';
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
 * comment above each group says what that group is for.
 *
 * Twelve of the twenty-four declare a `measure`, a number in the health snapshot their run is
 * scored on moving. The other twelve are recorded as unmeasured rather than scored, and each is
 * waiting on a gauge the snapshot does not carry yet:
 *
 * - `claim_dedup`: a near-duplicate claim-pair count.
 * - `claim_consolidation`: claim neighbourhoods above the derived density floor.
 * - `narrative_rollup_day` and `narrative_rollup_week`: closed windows carrying uncompressed
 *   narratives of the scope below.
 * - `memory_decay`: edge weight above the floor, which is what a decay pass lowers.
 * - `narrative_cleanup`: duplicate standing narratives per session.
 * - `retro_judgment_sweep`: episodes whose contradictions no judge has read.
 * - `description_freshness`: entities whose gloss predates their newest mentions.
 * - `community_refresh`: nodes carrying a community assignment older than their edges.
 * - `symbiosis_bridge`: the count of community pairs the graph connects least.
 * - `merge_decision_reconcile`: merges committed to the graph with no decision record.
 * - `structural_discovery`: entities carrying fewer associations than a degree ceiling.
 *
 * Each is a graph read nothing computes on the tick today. Until one exists, its operation is
 * scored on relevance, waiting time, and cost alone, which is everything known about it.
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

    // Compression, on both of its axes: the scopes above a session, and the claims that turn
    // out to be one subject said many times. Each writes one grounded memory and closes what it
    // absorbed, which is the ordinary supersession every one of those closes can be undone by.
    dayNarrativeRollupOperation(),
    weekNarrativeRollupOperation(),
    claimConsolidationOperation(),

    // Topology: repair connectivity, then re-derive the neighbourhoods, then join the two the
    // graph connects least. Listed in that order because it is the order they depend on each
    // other, not because the engine reads it.
    backboneRepairOperation(),
    orphanCleanupOperation(),
    communityRefreshOperation(),
    symbiosisBridgeOperation(),
    // Joins two identities the graph left apart: a nearest neighbour brings the pair forward
    // and a reading of the store decides whether anything stands behind it.
    structuralDiscoveryOperation(),

    // Entity-merge policy: tier 0 of the dedup cascade, swept over the whole graph rather than
    // over one episode. It absorbs the spellings the identity key cannot tell apart and asks no
    // model, since neither reading is a judgment about the world. Claim-merge policy sits beside
    // it: a nearest-neighbor pair a two-pass judge unanimously calls one assertion restated.
    mergeAutoOperation(),
    claimDedupOperation(),
    // The merge's own two-store seam: the graph commits a merge before the decision record
    // reaches SQLite, and no candidate read can find that pair again to re-decide it.
    mergeDecisionReconcileOperation(),

    // The queue's own hygiene: ages a proposal out once nobody has acted on it inside its
    // horizon, ledgered and reversible with `aion proposals reopen`.
    proposalHygieneOperation(),
  ];
}

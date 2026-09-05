import { z } from 'zod';

import { nonNegativeInt, positiveInt, proportion } from './knob-types.js';

/**
 * The `maintenance` group's own table, split out of `knobs.ts` because that file sits at the
 * 500-line lint cap: `maintenance` is the fastest-growing group (most introspection operations
 * declare a batch bound here, and the ones that write model output in place also declare a kill
 * switch), and a table that already fills its file grows in the file least likely to have room.
 * `knobs.ts` folds this back in as its `maintenance` leaf, so the split is invisible to every
 * reader of `KNOBS` or `KNOB_TABLE`.
 */

export const MAINTENANCE_KNOBS = {
  // The strategic layer's kill switch. On by default: a cycle the deterministic tiers left
  // idle consults the model, and the standing cost is one reflect-model generation on any
  // tick that reaches tier 3 with a candidate whose relevance is above zero. A tick where
  // every candidate reads zero, and a tick on a degraded snapshot, skip the call entirely.
  // Off stops the consultation at the branch, which is what the loop did before.
  tier3: ['AION_MAINTENANCE_TIER3', z.boolean(), true],
  // What an accepted recommendation is allowed to do. `propose` logs it and runs nothing,
  // which makes it the kill switch inside the kill switch. `act` sends it to a second model
  // call that argues the other side on the same reading, and runs it only when both passes
  // agree, through the same claim, bound, and scoring path a deterministic selection takes.
  // The default is set by measurement rather than by hand. The rule was pre-registered:
  // two-pass selection agreement at or above 0.9 with no invalid selection over the
  // twenty-four-case corpus ships `act`, anything less ships `propose`, and
  // `tier3-advisor-selection.int.test.ts` asserts the shipped value still matches what it
  // measures, in both directions.
  // Measured 2026-08-31 against claude-haiku-4-5, 24 readings: one call agreed with the
  // pre-committed answer on 12 of 24 and the two passes together on 12 of 24, with no
  // invalid selection. The second pass vetoed 20 of 23 recommendations, including ones the
  // corpus calls correct, so the advisor recommends and the loop runs nothing.
  tier3Mode: ['AION_MAINTENANCE_TIER3_MODE', z.enum(['propose', 'act']), 'propose'],
  // `merge_auto`'s kill switch. On by default: the sweep is deterministic and model-free, a
  // graph-wide pass over tier-0 squash- and alias-equality groups with no proposal queue and
  // no shadow-judge review at any point. Off no-ops the sweep entirely; the groups it would
  // have merged stay unmerged until it is back on.
  autoMerge: ['AION_AUTO_MERGE', z.boolean(), true],
  // How often the introspection loop observes, decides, and runs at most one operation.
  // Fifteen minutes is one bucket of the finest granularity an operation can declare, so every
  // operation gets at least one chance per window it is allowed to run in.
  tickMinutes: ['AION_MAINTENANCE_TICK_MINUTES', positiveInt, 15],
  // Cycles of being passed over that double an operation's urgency, the anti-starvation span.
  // Eight is two hours of ticks: an operation with real but small relevance reaches the
  // threshold inside a working session rather than inside a week.
  starvationCycles: ['AION_MAINTENANCE_STARVATION_CYCLES', positiveInt, 8],
  /** Urgency a routine operation must reach before the loop will run it at all. */
  urgencyThreshold: ['AION_MAINTENANCE_URGENCY_THRESHOLD', proportion, 0.2],
  // The deprioritization line: at or above it an operation scores at full weight, under it at
  // half, and starvation still eventually runs it either way. Never an exclusion.
  effectivenessFloor: ['AION_MAINTENANCE_EFFECTIVENESS_FLOOR', proportion, 0.5],
  // The cost term the routine tier divides urgency by, in three parts. A run at or under
  // `costReferenceMs` pays nothing and the divisor rises from there. `costDecades` is how many
  // decades of cost above the reference that rise spreads over; the catalog's own runs span
  // about three, from a SQLite tally to a batch of model calls. `maxCostDivisor` is where the
  // rise stops, so cost breaks a tie between comparable candidates and never vetoes one: the
  // dearest operation in the catalog still crosses the threshold on a reading that calls for it,
  // and starvation still reaches it.
  costReferenceMs: ['AION_MAINTENANCE_COST_REFERENCE_MS', positiveInt, 1_000],
  costDecades: ['AION_MAINTENANCE_COST_DECADES', positiveInt, 3],
  maxCostDivisor: ['AION_MAINTENANCE_MAX_COST_DIVISOR', z.number().min(1), 2],
  // `vector_backfill`'s content-vector pass: pending `:Memory` nodes embedded in one run, at
  // hebbian.batchSize's own default, since this is the same shape of work as a reinforcement flush.
  vectorBackfillBatchSize: ['AION_MAINTENANCE_VECTOR_BACKFILL_BATCH_SIZE', positiveInt, 100],
  // `vector_backfill`'s context-vector pass, a fifth of the content-vector batch: staleness
  // here is a quality gap the next pipeline run corrects anyway, not a hole in vector search.
  contextRefreshBatchSize: ['AION_MAINTENANCE_CONTEXT_REFRESH_BATCH_SIZE', positiveInt, 20],
  /** `reconcile_reenqueue`'s bound: orphaned episodes re-enqueued in one run. */
  reconcileBatchSize: ['AION_MAINTENANCE_RECONCILE_BATCH_SIZE', positiveInt, 200],
  // `aion replay`'s page over the experience archive: rows read and put back through the
  // pipeline before the next keyset page. Fifty matches `reconcileBatchSize`'s reasoning at a
  // quarter of the size, since every row here can cost a full pipeline run rather than one
  // enqueue, and the page is also the abort granularity: a smaller page loses less work.
  replayBatchSize: ['AION_MAINTENANCE_REPLAY_BATCH_SIZE', positiveInt, 50],
  /** `dead_letter`'s bound: attempts-exhausted rows given their one retry cycle in one run. */
  deadLetterBatchSize: ['AION_MAINTENANCE_DEAD_LETTER_BATCH_SIZE', positiveInt, 50],
  // `redaction_residue_purge`'s bound: nodes rewritten in one run. Small, since every hit is a
  // live property write and a wrong redaction destroys content permanently (nothing here hard-deletes).
  redactionPurgeBatchSize: ['AION_MAINTENANCE_REDACTION_PURGE_BATCH_SIZE', positiveInt, 20],
  // `narrative_cleanup`'s bound: sessions (not narratives) examined per run, for both the
  // duplicate scan and the stale-grounding sweep; ten is a modest tick even at the worst mix.
  narrativeCleanupBatch: ['AION_MAINTENANCE_NARRATIVE_CLEANUP_BATCH', positiveInt, 10],
  // `retro_judgment_sweep`'s bound: fact-bearing episodes judged per run. Each episode costs
  // up to eight judgment calls (supersession's own ceiling), so five keeps one tick's model
  // spend in line with an ordinary reflection run.
  retroSupersessionBatch: ['AION_MAINTENANCE_RETRO_SUPERSESSION_BATCH', positiveInt, 5],
  // `description_freshness`'s kill switch. It is the one operation that replaces stored text
  // with model output in place rather than closing a node and writing a new one, so an
  // operator who distrusts the rewrite needs a way to stop it that is not a code change.
  descriptionFreshness: ['AION_MAINTENANCE_DESCRIPTION_FRESHNESS', z.boolean(), true],
  // `description_freshness`'s bound: entities re-synthesized per run. Each entity costs one
  // generation call and one embed. Small on purpose: a refresh a tick behind is a staleness
  // window, not an outage.
  descriptionRefreshBatch: ['AION_MAINTENANCE_DESCRIPTION_REFRESH_BATCH', positiveInt, 3],
  // Mentions an entity must gain since its description was last written before it qualifies
  // for refresh. Five is enough traffic to plausibly have added something worth folding in,
  // without refreshing on every other mention.
  descriptionRefreshMentionGrowth: [
    'AION_MAINTENANCE_DESCRIPTION_REFRESH_MENTION_GROWTH',
    positiveInt,
    5,
  ],
  // `emergency_relationship_repair`'s bound: broken episode-to-session links restored in one
  // run. One indexed lookup and one edge write per break, the cheapest repair in the catalog,
  // so the batch matches the orphan sweep it sits beside.
  backboneRepairBatch: ['AION_MAINTENANCE_BACKBONE_REPAIR_BATCH', positiveInt, 200],
  // `orphan_cleanup`'s bound: disconnected nodes examined in one run. Two graph reads and at
  // most one small write per orphan, so a couple of hundred is a tick's work even when every
  // one of them needs a repair.
  orphanCleanupBatch: ['AION_MAINTENANCE_ORPHAN_CLEANUP_BATCH', positiveInt, 200],
  // How long an orphan with no relink candidate is left alone before it is forgotten. A month
  // with no candidate and no new edge: anything the pipeline was going to attach has long
  // since attached, and forgetting is reversible in the sense that matters here, since the
  // node stays readable under `as_of`.
  orphanForgetAfterDays: ['AION_MAINTENANCE_ORPHAN_FORGET_AFTER_DAYS', positiveInt, 30],
  // `community_refresh` declines above this rather than project part of the graph and answer
  // from it. The projection is in-memory and all-or-nothing, and twenty thousand nodes is well
  // past a laptop-scale substrate and still inside a heap the compose file caps at 1G.
  communityNodeLimit: ['AION_MAINTENANCE_COMMUNITY_NODE_LIMIT', positiveInt, 20_000],
  // Nodes below which a community answer is noise, not structure. The critical rules' own floor.
  communityMinNodes: ['AION_MAINTENANCE_COMMUNITY_MIN_NODES', positiveInt, 20],
  // Members a community needs before `symbiosis_bridge` may use it as an endpoint. Three is
  // the smallest group that can be a neighbourhood rather than a pair.
  bridgeMinCommunitySize: ['AION_MAINTENANCE_BRIDGE_MIN_COMMUNITY_SIZE', positiveInt, 3],
  // Share of the smaller community's size, in edges already crossing to the other one, above
  // which the pair counts as connected and `symbiosis_bridge` skips it. One crossing edge for
  // every four members of the smaller side: below that the two are joined by a thread, and at
  // or above it activation already has a way across, so a bridge would buy nothing.
  bridgeOverlapCeiling: ['AION_MAINTENANCE_BRIDGE_OVERLAP_CEILING', proportion, 0.25],
  // `proposal_hygiene`'s kill switch. On by default: the op only ever resolves a row past
  // its age horizon, and every dismissal is ledgered with the pair's identity, so a wrong
  // one is retro-judged from a real record rather than guessed at. Off leaves every
  // proposal queued for a person, same as before this op existed.
  proposalHygiene: ['AION_MAINTENANCE_PROPOSAL_HYGIENE', z.boolean(), true],
  // The fast horizon: how long a proposal detected from a pure tool-exhaust episode (no
  // turns, only tool calls) sits open before hygiene dismisses it. A day is enough for a
  // person to notice a genuine one; the source episode carries no conversation to judge.
  hygienePollutedAgeHours: ['AION_MAINTENANCE_HYGIENE_POLLUTED_AGE_HOURS', positiveInt, 24],
  // The ordinary horizon: how long any other open proposal sits before hygiene dismisses
  // it. Two weeks, long enough that a person who checks proposals occasionally still gets
  // to them first.
  hygieneResidueAgeDays: ['AION_MAINTENANCE_HYGIENE_RESIDUE_AGE_DAYS', positiveInt, 14],
  // A tick's ceiling on model calls the entity-merge judge makes, independent of the scan
  // ceiling. Matches `retroSupersessionBatch`'s own reasoning: bound the cost of a run
  // that finds a full page of ordinary-residue pairs needing a verdict.
  hygieneJudgeBatch: ['AION_MAINTENANCE_HYGIENE_JUDGE_BATCH', positiveInt, 5],
  // `proposal_resolution`'s kill switch. On by default: every verdict it reaches is terminal
  // and recorded, an apply takes the same path and the same blade a person's apply takes, and
  // `aion unsupersede` and `aion unmerge` reverse one exactly as they reverse anyone's. Off
  // leaves both queues waiting for `aion proposals` and for the hygiene horizon behind it.
  proposalResolution: ['AION_PROPOSAL_RESOLUTION', z.boolean(), true],
  // Open rows one run decides, read oldest first across both queues. Each row costs two model
  // calls and a handful of graph reads, so ten is an hour's modest spend and a queue of any
  // size drains at ten an hour rather than in one burst nobody watched.
  resolutionBatch: ['AION_RESOLUTION_BATCH', positiveInt, 10],
  // `reinforcement_flush` and `memory_decay`'s kill switches, the pair every other weight
  // operation already had. Off, the operation is a noop: signals wait in the queue, and stale
  // edges hold the strength they have. The rates and batch sizes stay in the `hebbian` group.
  reinforcementFlush: ['AION_MAINTENANCE_REINFORCEMENT_FLUSH', z.boolean(), true],
  memoryDecay: ['AION_MAINTENANCE_MEMORY_DECAY', z.boolean(), true],
  // `edge_prune`'s kill switch, aging threshold, and batch; edge-prune.ts states the arithmetic.
  edgePrune: ['AION_MAINTENANCE_EDGE_PRUNE', z.boolean(), true],
  edgePruneUnreinforcedDays: ['AION_MAINTENANCE_EDGE_PRUNE_UNREINFORCED_DAYS', positiveInt, 14],
  edgePruneBatch: ['AION_MAINTENANCE_EDGE_PRUNE_BATCH', positiveInt, 1000],
  /** `identifier_decay`'s four; identifier-shape.ts and identifier-decay.ts state the arithmetic. */
  identifierDecay: ['AION_MAINTENANCE_IDENTIFIER_DECAY', z.boolean(), true],
  identifierDecayBatch: ['AION_MAINTENANCE_IDENTIFIER_DECAY_BATCH', positiveInt, 500],
  identifierHalfLifeDays: ['AION_MAINTENANCE_IDENTIFIER_HALF_LIFE_DAYS', positiveInt, 7],
  identifierMentionFloor: ['AION_MAINTENANCE_IDENTIFIER_MENTION_FLOOR', positiveInt, 5],
  // `claim_dedup`'s kill switch. On by default: the merge only ever runs on a pair a two-pass
  // judge unanimously called one assertion restated, the same discipline `merge_auto` follows
  // for squash- and alias-equality entity pairs. Off stops the scan and every model call it
  // would have made; the near-duplicate claims stay in the graph exactly as extraction left them.
  claimDedup: ['AION_MAINTENANCE_CLAIM_DEDUP', z.boolean(), true],
  // Pairs judged per run. Every pair costs up to two model calls (the detection pass, then the
  // second pass arguing the other side), the same ceiling `retroSupersessionBatch` sets for
  // its own per-item cost, and the ledger key each pair earns on its way through is what keeps
  // a re-run from paying for it twice.
  claimDedupBatch: ['AION_MAINTENANCE_CLAIM_DEDUP_BATCH', positiveInt, 5],
  // The nearest-neighbor cosine a pair must clear before the judge is asked at all. A
  // nomination floor: what merges is what the two-pass judge calls one assertion restated, and
  // this only decides which pairs it is asked about. Re-derived 2026-09-02 against
  // snowflake-arctic-embed2 on claim text: one assertion written twice min 0.787, p05 0.830,
  // p50 0.929, max 0.981; two claims that share nothing min 0.101, p50 0.274, max 0.672. 0.73
  // is the midpoint of that gap, 0.058 above the strongest unrelated pair and 0.057 under the
  // weakest restatement, both margins about twice the 0.03 drift tolerance. Claims about one
  // subject that are not one assertion (the 24 supersession battery pairs, min 0.408, p50
  // 0.814, max 0.932) sit inside the restatement band and no floor separates them, which is
  // what the judge is for. The nomic-era value was 0.95, which one pair in 186,355 reached.
  claimDedupCosineFloor: ['AION_MAINTENANCE_CLAIM_DEDUP_COSINE_FLOOR', proportion, 0.73],
  // `merge_decision_reconcile`'s bound: canonicals whose merge trail is read per run. The
  // graph commits a merge before its SQLite record exists, so a process that dies in between
  // leaves a decision key nothing answers for, and no candidate read can find that pair again
  // to re-decide it. Two hundred matches the other trail-walking sweeps: one indexed read per
  // canonical and, in the healthy case, no write at all.
  mergeDecisionReconcileBatch: [
    'AION_MAINTENANCE_MERGE_DECISION_RECONCILE_BATCH',
    positiveInt,
    200,
  ],
  // The kill switch both narrative rollup scopes read. On by default, which is what acting from
  // day one means for an operation whose whole risk is reversible: every rollup is a
  // supersession, and `aion unsupersede` reopens any member it closed. Off leaves a day and a
  // week of sessions reaching recall as the separate stories the close wrote.
  narrativeRollup: ['AION_MAINTENANCE_NARRATIVE_ROLLUP', z.boolean(), true],
  // Closed windows one run compresses, per scope. Two is a backlog that drains at a steady pace:
  // each window is a model call and its review, and a substrate with a month of unrolled days
  // works through them a tick at a time.
  narrativeRollupWindows: ['AION_MAINTENANCE_NARRATIVE_ROLLUP_WINDOWS', positiveInt, 2],
  // `claim_consolidation`'s kill switch. On by default: the write is a supersession like any
  // other, and `aion unsupersede` reopens every claim it absorbed. Off leaves many standing
  // claims about one subject in the graph as extraction wrote them.
  claimConsolidation: ['AION_MAINTENANCE_CLAIM_CONSOLIDATION', z.boolean(), true],
  // `structural_discovery`'s kill switch. On by default: a nearest-neighbour cosine brings a
  // pair forward and only the store may write the edge, so a pair carrying a cosine and no
  // graph evidence is dropped and counted rather than written weakly. Off leaves every
  // under-connected identity exactly as it is.
  structuralDiscovery: ['AION_MAINTENANCE_STRUCTURAL_DISCOVERY', z.boolean(), true],
  // Association edges an identity may already hold and still count as under-connected. Two is
  // conservative on purpose: the substrate this ships onto has no history to measure against,
  // and a ceiling raised later reaches strictly more pairs, while edges written under one too
  // high are already in the graph. Re-derive it against the degree distribution a graph grows.
  structuralDiscoveryDegreeCeiling: [
    'AION_MAINTENANCE_STRUCTURAL_DISCOVERY_DEGREE_CEILING',
    nonNegativeInt,
    2,
  ],
  /** Under-connected identities one run seeds the nomination read with. */
  structuralDiscoverySeedBatch: [
    'AION_MAINTENANCE_STRUCTURAL_DISCOVERY_SEED_BATCH',
    positiveInt,
    200,
  ],
  // Nominated pairs one run gathers evidence for and may write. A day bucket and twenty-five
  // pairs is a slow build by design: the pairs are ranked by cosine, so a capped run takes the
  // strongest of them and the next run takes what the substrate has grown into since.
  structuralDiscoveryBatch: ['AION_MAINTENANCE_STRUCTURAL_DISCOVERY_BATCH', positiveInt, 25],
} as const;

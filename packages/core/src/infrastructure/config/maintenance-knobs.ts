import { z } from 'zod';

/**
 * The `maintenance` group's own table, split out of `knobs.ts` because that file sits at the
 * 500-line lint cap: `maintenance` is the fastest-growing group (nearly every introspection
 * operation ships its own kill switch and batch here), and a table that already fills its file
 * grows in the file least likely to have room. `knobs.ts` folds this back in as its
 * `maintenance` leaf, so the split is invisible to every reader of `KNOBS` or `KNOB_TABLE`.
 */
const proportion = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();

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
  // `vector_backfill`'s content-vector pass: pending `:Memory` nodes embedded in one run, at
  // hebbian.batchSize's own default, since this is the same shape of work as a reinforcement flush.
  vectorBackfillBatchSize: ['AION_MAINTENANCE_VECTOR_BACKFILL_BATCH_SIZE', positiveInt, 100],
  // `vector_backfill`'s context-vector pass, a fifth of the content-vector batch: staleness
  // here is a quality gap the next pipeline run corrects anyway, not a hole in vector search.
  contextRefreshBatchSize: ['AION_MAINTENANCE_CONTEXT_REFRESH_BATCH_SIZE', positiveInt, 20],
  /** `reconcile_reenqueue`'s bound: orphaned episodes re-enqueued in one run. */
  reconcileBatchSize: ['AION_MAINTENANCE_RECONCILE_BATCH_SIZE', positiveInt, 200],
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
  // The nearest-neighbor cosine a pair must clear before the judge is asked at all. Measured
  // against the live graph: of the 250 most recent claims, 28 (11%) had a neighbor at or
  // above this floor, median nearest-neighbor 0.908, against calibration p50 0.408 unrelated
  // and 0.773 related. The 0.90-0.95 band is partly single-project vocabulary and stays untouched.
  claimDedupCosineFloor: ['AION_MAINTENANCE_CLAIM_DEDUP_COSINE_FLOOR', proportion, 0.95],
} as const;

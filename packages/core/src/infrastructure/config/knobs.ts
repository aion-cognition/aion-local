import { z } from 'zod';

import {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  LOG_FILE_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVELS,
} from '../logging/logger.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic-provider.js';
import { DEFAULT_SQLITE_PATH, SQLITE_PATH_ENV_VAR } from '../sqlite/database.js';
import { DEFAULT_REINFORCEMENT_QUEUE_CAP } from '../sqlite/reinforcement-queue.js';

export type KnobKind = 'string' | 'number' | 'boolean' | 'weights' | 'stringList';

export type ConfigPath = readonly [group: string, leaf: string];

/**
 * One knob: the env var that sets it, the zod type that both validates it and gives the leaf its
 * TypeScript type, and the value it holds when nothing sets it. `kind` names the decoder, and
 * only a knob whose one var feeds a whole subtree needs it. Every other decoder follows from the
 * type of the value, since that is the type the schema accepts.
 *
 * A tuple rather than an object because a knob is three facts in a fixed order and one row per
 * knob is what keeps the whole catalog readable in one screenful per group.
 */
export type KnobDeclaration = readonly [
  envVar: string,
  schema: z.ZodType,
  value: unknown,
  kind?: KnobKind,
];

export type KnobTable = Readonly<Record<string, Readonly<Record<string, KnobDeclaration>>>>;

/**
 * Range constraints match a specific pinned value where one exists; the rest (int/positive/0-1)
 * are defensive shape checks, not tuned limits.
 */
const proportion = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const positive = z.number().positive();
const text = z.string().min(1);
const searchMethod = z.enum(['vector', 'bm25', 'graph_traversal']);
const providerPin = z.enum(['auto', 'ollama', 'anthropic']);

/**
 * Every knob the program has, declared once, as `leaf: [envVar, schema, value]`. The schema
 * tree, the default tree, and the flat AION_* catalog are all folded out of this table, so the
 * three cannot disagree, and the nesting is the config path: group, then leaf.
 *
 * One entry is one Config leaf and one env var, with `search.weights` the exception: a single
 * comma-separated var feeds all three sub-fields, which is what the trailing `'weights'`
 * declares.
 *
 * Two knobs are declared ahead of a reader. `recall.compressionThreshold` is overridable and
 * unread until narrative compression lands; it is here now because a knob added late is a knob
 * whose name and range were never reviewed, and setting one today changes nothing.
 * `maintenance.tier3` gates the introspector's tier-3 seam, which consults the advisor and
 * records what it would have been asked; the model call itself is unbuilt, so turning it on
 * changes what is logged and nothing that runs.
 *
 * `redaction.entropyThreshold` and `operational.dataDir` have no pinned spec default; they
 * follow common secret-scanner practice (4.5 bits/char) and the compose data volume mount
 * point. `operational.workerCount` defaults to 1, one worker per process.
 */
export const KNOBS = {
  neo4j: {
    uri: ['AION_NEO4J_URI', text, 'bolt://neo4j:7687'],
    password: ['AION_NEO4J_PASSWORD', z.string(), ''],
  },
  ollama: {
    url: ['AION_OLLAMA_URL', text, 'http://host.docker.internal:11434'],
  },
  models: {
    embed: ['AION_EMBED_MODEL', text, 'nomic-embed-text'],
    embedDimension: ['AION_EMBED_DIMENSION', positiveInt, 768],
    cue: ['AION_CUE_MODEL', text, 'qwen3:1.7b'],
    reflect: ['AION_REFLECT_MODEL', text, 'qwen3:8b'],
  },
  anthropic: {
    /** Empty string means fully local; a non-empty key opts a call class into a remote provider. */
    apiKey: ['AION_ANTHROPIC_API_KEY', z.string(), ''],
    /** The model every remote-routed generation names, whatever model the caller asked for. */
    model: ['AION_ANTHROPIC_MODEL', text, DEFAULT_ANTHROPIC_MODEL],
  },
  /**
   * Per-role provider pins. `auto` follows the key: set, and every generation role goes to
   * Anthropic; unset, and everything is local. A pin overrides that for one role in either
   * direction, which is what lets cue extraction stay on the fast local model while reflection
   * runs remotely, or the reverse. Embeddings are not a role here: one model owns the vector
   * space for the life of the substrate. Both vars are named for the role they pin rather than
   * AION_ROUTING_*, so they read next to the model vars they route.
   */
  routing: {
    cue: ['AION_CUE_PROVIDER', providerPin, 'auto'],
    reflect: ['AION_REFLECT_PROVIDER', providerPin, 'auto'],
  },
  recall: {
    // Three, not two: the cross-session graph routes every path through a Session hub, and
    // Episode -PARTICIPATES_IN-> Session -FOLLOWS-> Session -PARTICIPATES_IN-> Episode is three
    // hops. At two the FOLLOWS chain reaches nothing but a contentless Session node.
    maxHops: ['AION_RECALL_MAX_HOPS', nonNegativeInt, 3],
    vectorLimit: ['AION_RECALL_VECTOR_LIMIT', positiveInt, 5],
    maxFacts: ['AION_RECALL_MAX_FACTS', nonNegativeInt, 15],
    // Twenty, raised from five. The cap cuts the fused list, so it decides what survives fusion
    // competition rather than how big a pack gets: on a populated substrate (~40 episodes)
    // near-tie vector hits fill the first five, and the one traversal-reached item ranked 13th
    // is absent at 5, 8, and 12 and present at 20. Activation runs on every recall either way;
    // the cap decides whether the caller sees what it found. The token budget, not this number,
    // is what actually bounds a pack.
    maxEpisodes: ['AION_RECALL_MAX_EPISODES', nonNegativeInt, 20],
    maxNarratives: ['AION_RECALL_MAX_NARRATIVES', nonNegativeInt, 5],
    maxPreferences: ['AION_RECALL_MAX_PREFERENCES', nonNegativeInt, 3],
    maxResonant: ['AION_RECALL_MAX_RESONANT', nonNegativeInt, 5],
    useContextResonance: ['AION_RECALL_USE_CONTEXT_RESONANCE', z.boolean(), true],
    // Whether a session is served the same unchanged memory twice. On by default: a per-prompt
    // hook recalls many times inside one conversation, the top of the ranked list barely moves
    // between them, and everything already served is still in the agent's context, so the
    // repeat spends the pack's whole budget on text the agent is still reading. Off restores
    // the full pack on every call, which is what a caller that keeps no conversation wants.
    sessionDedup: ['AION_RECALL_SESSION_DEDUP', z.boolean(), true],
    // At `hebbian.weightFloor`, deliberately. Decay clamps a weight at the floor so a faded
    // pathway stays traversable, and a traversal cutoff above the floor would sever the whole
    // band the clamp exists to keep. Fading is proportional (spreading activation scales
    // propagation by strength); this number is only the point at which an edge counts as gone.
    associationStrength: ['AION_RECALL_ASSOCIATION_STRENGTH', proportion, 0.1],
    compressionThreshold: ['AION_RECALL_COMPRESSION_THRESHOLD', positiveInt, 512],
    // A hang guard, not a latency target: the failure it catches is a call that never returns,
    // so it must not fire on ordinary calls. The cue model's cold-start round trip measured
    // 2288ms on host Ollama against 527-937ms warm, and 2000 still fired on an ordinary recall
    // at 2030ms, so the headroom a cold start needs is several multiples of the warm case.
    cueBudgetMs: ['AION_CUE_BUDGET_MS', positiveInt, 8000],
    tokenBudget: ['AION_RECALL_TOKEN_BUDGET', positiveInt, 1200],
    // Absolute cosine floors, measured against the embedding model's noise rather than pinned.
    // Against nomic-embed-text on 28 unrelated pairs and 10 genuine matches
    // (`floors.fixtures.ts`): unrelated p50 0.408, p95 0.530, max 0.547; related min 0.451, p50
    // 0.773. The tails overlap, so no floor separates them, and the answer to an overlap is
    // corroboration rather than a lower floor. `vectorAdmissionFloor` sits above the whole noise
    // sample and admits one measurement alone; a floor at 0.50 sat inside the overlap band and
    // admitted off-topic text on one leg. `corroborationFloor` is the lower bar a measurement
    // clears to count as one of the two an item can be corroborated on, and it too sits above
    // the noise range: two readings at 0.46 and 0.51 are two readings of the same noise, which
    // is what admitted every surviving item on the gate's off-topic probes.
    // `floor-calibration.int.test.ts` re-measures both and fails when the committed values stop
    // separating the distributions.
    vectorAdmissionFloor: ['AION_VECTOR_ADMISSION_FLOOR', proportion, 0.6],
    corroborationFloor: ['AION_CORROBORATION_FLOOR', proportion, 0.55],
    /** A Lucene score is corpus-relative, so the lexical leg admits by rule, not by number. */
    bm25AdmissionMode: [
      'AION_BM25_ADMISSION_MODE',
      z.enum(['exact', 'corroborated', 'any']),
      'exact',
    ],
    /**
     * Entity resolution's fuzzy leg needs a name-similarity floor of its own; borrowing
     * `contextResonance.contextSearchThreshold` would make one env var mean two unrelated
     * things once the fuzzy matcher lands.
     */
    entityMatchThreshold: ['AION_RECALL_ENTITY_MATCH_THRESHOLD', proportion, 0.7],
    // A near-duplicate cluster's cap on how many of its members one bucket may hold, after a
    // burst of near-identical episodes took 29.5% of a pack's slots. Two survivors keeps a
    // cluster's best-ranked content visible (a pack that answers "did we ever discuss X" still
    // gets one example) without one burst shape consuming the entire bucket.
    clusterCap: ['AION_PACK_CLUSTER_CAP', positiveInt, 2],
    // The facts bucket's own three rules, after entity glosses took 58% of fact slots and
    // Decision nodes 3% on a decision-oriented workload. `entityGlossCap` bounds the glosses at
    // four: a pack that answers "who is involved in X" needs room for more than one name while
    // still leaving eleven of fifteen fact slots to content that states something.
    entityGlossCap: ['AION_PACK_ENTITY_GLOSS_CAP', positiveInt, 4],
    // `restatementFloor` is the cosine at or above which a Goal or Plan is judged to be the
    // query said back rather than answered. Measured against nomic-embed-text on two
    // distributions of Goal/Plan text, both scored against the query that would retrieve them
    // (`facts.fixtures.ts`): nodes that restate the query min 0.841 p50 0.909, nodes that answer
    // it p50 0.552 max 0.729. 0.80 sits in the gap and caught 8 of 8 restatements with 0 of 8
    // misfires. `facts-calibration.int.test.ts` re-measures both and fails if they stop
    // separating.
    restatementFloor: ['AION_FACTS_RESTATEMENT_FLOOR', proportion, 0.8],
    // `decisionBoost` multiplies the fused score of Decision and Insight when the cue model
    // judged the query decision-shaped. At rrfConstant 60 a factor of 1.25 is worth about
    // fifteen ranks, which is the facts cap: enough to bring a Decision any leg ranked into the
    // bucket, not enough to let one no leg ranked displace the top hit.
    decisionBoost: ['AION_DECISION_INTENT_BOOST', z.number().min(1), 1.25],
    // Cosine at or above which the current claim in a raw turn's subject family is printed
    // beside the turn. The family match has already established that the two name the same
    // subject; this keeps a claim that merely shares a name off the item. Above the whole
    // unrelated sample this embedding model produced (max 0.547 in `floors.fixtures.ts`); the
    // contradicting pair this was built for measured 0.79 turn to claim, and the next claim in
    // the same family 0.68.
    relatedClaimFloor: ['AION_RELATED_CLAIM_FLOOR', proportion, 0.55],
  },
  search: {
    methods: [
      'AION_SEARCH_METHODS',
      z.array(searchMethod).min(1),
      ['vector', 'bm25', 'graph_traversal'],
    ],
    reranker: ['AION_SEARCH_RERANKER', z.enum(['rrf', 'mmr']), 'rrf'],
    rrfConstant: ['AION_SEARCH_RRF_CONSTANT', positiveInt, 60],
    mmrLambda: ['AION_SEARCH_MMR_LAMBDA', proportion, 0.5],
    /** One var carries all three weights, comma-separated in the order vector,bm25,graph. */
    weights: [
      'AION_SEARCH_WEIGHTS',
      z.object({ vector: proportion, bm25: proportion, graph: proportion }),
      { vector: 0.4, bm25: 0.3, graph: 0.3 },
      'weights',
    ],
  },
  activation: {
    maxIterations: ['AION_ACTIVATION_MAX_ITERATIONS', positiveInt, 100],
    decayFactor: ['AION_ACTIVATION_DECAY_FACTOR', proportion, 0.7],
    minActivation: ['AION_ACTIVATION_MIN_ACTIVATION', proportion, 0.1],
    maxNodesVisited: ['AION_ACTIVATION_MAX_NODES_VISITED', positiveInt, 500],
    hubThreshold: ['AION_ACTIVATION_HUB_THRESHOLD', positiveInt, 10],
  },
  hebbian: {
    weightFloor: ['AION_HEBBIAN_WEIGHT_FLOOR', proportion, 0.1],
    learningRate: ['AION_HEBBIAN_LEARNING_RATE', proportion, 0.1],
    decayRate: ['AION_HEBBIAN_DECAY_RATE', proportion, 0.05],
    decayPeakDays: ['AION_HEBBIAN_DECAY_PEAK_DAYS', positiveInt, 30],
    decaySigma: ['AION_HEBBIAN_DECAY_SIGMA', positive, 15],
    batchSize: ['AION_HEBBIAN_BATCH_SIZE', positiveInt, 100],
  },
  contextResonance: {
    // The ceiling on the seed budget rather than the budget itself. The budget is
    // `seedBudgetBase + seedBudgetGrowth * ln(memory nodes)`, so this is what a substrate large
    // enough to reach it settles at, and pinning it low pins the budget outright. Raised from
    // 10, which used to be the whole budget: ten seeds are the entire candidate set, so on a
    // substrate of several thousand memories a node that answers the query above the admission
    // floor was never measured, because it was never a candidate. The curve reaches this ceiling
    // near sixty thousand memory nodes and stays under `activationLimit`, so the spread still
    // has room to return something the seeds did not already carry. The var keeps its spelling
    // because a deployment that pinned it low still gets exactly that many seeds.
    seedLimit: ['AION_CONTEXT_RESONANCE_SEED_LIMIT', positiveInt, 32],
    seedBudgetBase: ['AION_SEED_BUDGET_BASE', positiveInt, 10],
    seedBudgetGrowth: ['AION_SEED_BUDGET_GROWTH', positive, 2],
    activationLimit: ['AION_CONTEXT_RESONANCE_ACTIVATION_LIMIT', positiveInt, 50],
    resonantLimit: ['AION_CONTEXT_RESONANCE_RESONANT_LIMIT', positiveInt, 20],
    contextSearchThreshold: ['AION_CONTEXT_RESONANCE_CONTEXT_SEARCH_THRESHOLD', proportion, 0.7],
  },
  /**
   * The reflection pipeline's per-stage knobs. Each stage owns its thresholds and caps as an
   * options type and takes the value as a constructor option, falling back to the leaf here, so
   * a knob and the pipeline that reads it cannot disagree. Before, each stage restated its own
   * copy and a test asserted the two still matched.
   */
  reflection: {
    // One hang guard on `provider.generate` for every generating stage, not a latency target:
    // reflection is asynchronous and the value that matters is that a model which never answers
    // cannot hold the worker forever. qwen3:8b with thinking on measured 10-44s with occasional
    // non-returns, and the orchestrator imposes no timeout of its own. Five per-stage knobs
    // carried the same 60s and no deployment ever split them, so a stage that needs its own
    // guard takes it as a constructor option instead of a knob nobody sets.
    stageTimeoutMs: ['AION_REFLECTION_STAGE_TIMEOUT_MS', positiveInt, 60_000],
    maxEntities: ['AION_REFLECTION_MAX_ENTITIES', positiveInt, 32],
    entityDedupThreshold: ['AION_REFLECTION_ENTITY_DEDUP_THRESHOLD', proportion, 0.85],
    associationSemanticThreshold: ['AION_ASSOC_SEMANTIC_THRESHOLD', proportion, 0.75],
    associationSimilarLimit: ['AION_REFLECTION_ASSOCIATION_SIMILAR_LIMIT', positiveInt, 5],
    maxCognitiveNodes: ['AION_REFLECTION_MAX_COGNITIVE_NODES', positiveInt, 20],
    maxRelationships: ['AION_REFLECTION_MAX_RELATIONSHIPS', positiveInt, 40],
    // `propose` writes every detection to `supersession_proposals` and closes nothing, which
    // makes it the kill switch. `unanimous` sends every affirmative judgment to a second model
    // call that argues the other side on the same evidence, and closes only what both passes
    // affirm. `auto` is the confidence gate both predate, still valid and superseded by
    // `unanimous`: the judge answers 0.95 to every affirmative, so its threshold is a
    // pass-through or a wall and never a discriminator.
    //
    // The default is set by measurement rather than by hand. The rule was pre-registered:
    // two-pass precision at or above 0.9 and recall at or above 0.9 on the 24-case battery
    // ships `unanimous`, anything less ships `propose`, and `supersession-precision.int.test.ts`
    // asserts the shipped value still matches what it measures, in both directions.
    //
    // Measured 2026-08-30 against claude-haiku-4-5, 24 pairs: two-pass TP 12, FP 0, FN 0,
    // TN 12, precision 1.000, recall 1.000. The second pass saw 14 affirmatives and vetoed 2,
    // both on survival, both the false positives the single pass emitted (precision 0.857 on
    // the same run). The reviewer's prompt was written against those two shapes before the
    // measurement, which is a real risk of fitting the instrument: the number to watch is
    // whether it holds on pairs this set does not contain.
    supersedeMode: ['AION_SUPERSEDE_MODE', z.enum(['propose', 'auto', 'unanimous']), 'unanimous'],
    /** The `auto` path's threshold only. No other mode reads it. */
    supersedeAutoConfidence: ['AION_SUPERSEDE_AUTO_CONFIDENCE', proportion, 0.85],
    supersedeNeighborThreshold: ['AION_REFLECTION_SUPERSEDE_NEIGHBOR_THRESHOLD', proportion, 0.75],
    // How close a sibling claim has to be to the judged one before a family apply closes it too.
    // Two claims from one observation can name the same subject and be about different things;
    // this is where that line sits. Under the neighbour threshold, because these two already
    // share an observation and a named subject: the evidence a family close needs on top of that
    // is that they are about the same thing, not that they nearly restate each other.
    supersedeFamilyRelatednessFloor: [
      'AION_REFLECTION_SUPERSEDE_FAMILY_RELATEDNESS_FLOOR',
      proportion,
      0.6,
    ],
    maxSupersessionSubjects: ['AION_REFLECTION_MAX_SUPERSESSION_SUBJECTS', positiveInt, 6],
    maxContradictionNeighbors: ['AION_REFLECTION_MAX_CONTRADICTION_NEIGHBORS', positiveInt, 3],
    maxContradictionJudgments: ['AION_REFLECTION_MAX_CONTRADICTION_JUDGMENTS', positiveInt, 8],
    /** Minutes, because that is the unit the pinned trigger is stated in (30 min idle). */
    narrativeIdleMinutes: ['AION_REFLECTION_NARRATIVE_IDLE_MINUTES', positiveInt, 30],
    maxNarrativeEpisodes: ['AION_REFLECTION_MAX_NARRATIVE_EPISODES', positiveInt, 40],
    maxNarrativeEpisodeChars: ['AION_REFLECTION_MAX_NARRATIVE_EPISODE_CHARS', positiveInt, 2_000],
    narrativeSweepLimit: ['AION_REFLECTION_NARRATIVE_SWEEP_LIMIT', positiveInt, 20],
  },
  /**
   * The arrival-rate backstop behind the reflection queue's priority lanes. The explicit `lane`
   * input is what normally decides; these bound the damage a client that floods without setting
   * it can do to everyone else's freshness. Measured against the live incident: four uncapped
   * harnesses pushed ~4,100 episodes in ten minutes across eight sessions, roughly 51 arrivals
   * per session per minute and 410 globally. `sessionArrivalMax` is 2 per minute, so that
   * pattern demotes inside the first few seconds, while a session-end flush of ten episodes at
   * once does not. `globalArrivalMax` is twelve busy sessions' worth: past it the substrate is
   * hot and each session's allowance drops to `hotSessionArrivalMax`, which is what stops enough
   * fresh sessions from reproducing the flood with every per-session counter reading green.
   */
  lanes: {
    arrivalWindowMs: ['AION_LANE_ARRIVAL_WINDOW_MS', positiveInt, 300_000],
    sessionArrivalMax: ['AION_LANE_SESSION_ARRIVAL_MAX', positiveInt, 10],
    globalArrivalMax: ['AION_LANE_GLOBAL_ARRIVAL_MAX', positiveInt, 120],
    hotSessionArrivalMax: ['AION_LANE_HOT_SESSION_ARRIVAL_MAX', positiveInt, 3],
  },
  redaction: {
    /** Shannon entropy in bits/char above which an unmatched token is still flagged as a likely secret. */
    entropyThreshold: ['AION_REDACTION_ENTROPY_THRESHOLD', positive, 4.5],
  },
  maintenance: {
    tier3: ['AION_MAINTENANCE_TIER3', z.boolean(), false],
    // `merge_auto`'s kill switch. On by default: the policy only acts on an exact-name
    // proposal, and every exact-name pair measured against two live review batches was a
    // merge a person went on to approve, with no disagreement the shadow judge recorded. Off
    // stops the operation from touching a proposal at all; open proposals keep queuing and
    // `aion proposals` stays the only way to resolve them until it is back on.
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
    // `vector_backfill`'s content-vector pass: pending `:Memory` nodes embedded in one run. At
    // hebbian.batchSize's own default, since a content-vector backfill is the same shape of work
    // as a reinforcement flush, one bounded pass over a pending queue.
    vectorBackfillBatchSize: ['AION_MAINTENANCE_VECTOR_BACKFILL_BATCH_SIZE', positiveInt, 100],
    // `vector_backfill`'s context-vector pass, a fifth of the content-vector batch. Context
    // staleness is a quality gap the next pipeline run corrects anyway, not a hole in vector
    // search, so each tick spends little on it.
    contextRefreshBatchSize: ['AION_MAINTENANCE_CONTEXT_REFRESH_BATCH_SIZE', positiveInt, 20],
    /** `reconcile_reenqueue`'s bound: orphaned episodes re-enqueued in one run. */
    reconcileBatchSize: ['AION_MAINTENANCE_RECONCILE_BATCH_SIZE', positiveInt, 200],
    /** `dead_letter`'s bound: attempts-exhausted rows given their one retry cycle in one run. */
    deadLetterBatchSize: ['AION_MAINTENANCE_DEAD_LETTER_BATCH_SIZE', positiveInt, 50],
    // `redaction_residue_purge`'s bound: nodes rewritten in one run. Small, because every hit is
    // a live property write and a wrong redaction destroys content permanently, since nothing in
    // the substrate is hard-deleted.
    redactionPurgeBatchSize: ['AION_MAINTENANCE_REDACTION_PURGE_BATCH_SIZE', positiveInt, 20],
    // `narrative_cleanup`'s bound: sessions examined per run, for both the duplicate scan and
    // the stale-grounding sweep. Sessions, not narratives: a session with duplicates costs one
    // supersede per straggler and a stale one a regeneration call, so ten sessions is a modest
    // tick even at the worst mix.
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
    // Nodes below which a community answer describes noise rather than structure. The same floor
    // the critical rules use.
    communityMinNodes: ['AION_MAINTENANCE_COMMUNITY_MIN_NODES', positiveInt, 20],
    // Members a community needs before `symbiosis_bridge` may use it as an endpoint. Three is
    // the smallest group that can be a neighbourhood rather than a pair.
    bridgeMinCommunitySize: ['AION_MAINTENANCE_BRIDGE_MIN_COMMUNITY_SIZE', positiveInt, 3],
    // Share of the smaller community's size, in edges already crossing to the other one, above
    // which the pair counts as connected and `symbiosis_bridge` skips it. One crossing edge for
    // every four members of the smaller side: below that the two are joined by a thread, and at
    // or above it activation already has a way across, so a bridge would buy nothing.
    bridgeOverlapCeiling: ['AION_MAINTENANCE_BRIDGE_OVERLAP_CEILING', proportion, 0.25],
  },
  sqlite: {
    path: [SQLITE_PATH_ENV_VAR, text, DEFAULT_SQLITE_PATH],
    /** Rows past this are dropped oldest-first at enqueue; the table has no consumer yet. */
    reinforcementQueueCap: [
      'AION_REINFORCEMENT_QUEUE_CAP',
      positiveInt,
      DEFAULT_REINFORCEMENT_QUEUE_CAP,
    ],
  },
  operational: {
    dataDir: ['AION_DATA_DIR', text, '/data'],
    mcpPort: ['AION_MCP_PORT', z.number().int().min(1).max(65535), 8765],
    workerCount: ['AION_WORKER_COUNT', positiveInt, 1],
    /** How long a claim outlives the process that took it before the next drain reclaims it. */
    workerStaleClaimTimeoutMs: ['AION_WORKER_STALE_CLAIM_TIMEOUT_MS', positiveInt, 600_000],
    workerRetryBaseMs: ['AION_WORKER_RETRY_BASE_MS', positiveInt, 5_000],
    workerRetryCapMs: ['AION_WORKER_RETRY_CAP_MS', positiveInt, 300_000],
    workerMaxAttempts: ['AION_WORKER_MAX_ATTEMPTS', positiveInt, 5],
    workerBreakerThreshold: ['AION_WORKER_BREAKER_THRESHOLD', positiveInt, 5],
    workerBreakerCooldownMs: ['AION_WORKER_BREAKER_COOLDOWN_MS', positiveInt, 60_000],
    workerVectorBatchSize: ['AION_WORKER_VECTOR_BATCH_SIZE', positiveInt, 64],
    /** Unenriched episodes `aion doctor` reports as a warning rather than a count. */
    reconcileWarnThreshold: ['AION_RECONCILE_WARN_THRESHOLD', nonNegativeInt, 50],
    // `aion doctor`'s `queue-lag` check warns past this age; no gauge existed at all before it.
    // Ten minutes clears the drain rate measured against the live substrate (1.9 to 6.7
    // episodes/min), so what it reports is a real backlog rather than noise.
    lagOldestUnclaimedWarnMs: ['AION_LAG_OLDEST_UNCLAIMED_WARN_MS', positiveInt, 600_000],
    /** The same judgment by depth instead of age: total unclaimed depth `queue-lag` warns past. */
    lagQueueDepthWarnThreshold: ['AION_LAG_QUEUE_DEPTH_WARN_THRESHOLD', nonNegativeInt, 200],
    // A client's `close()` tears down its transport locally without a DELETE, so the server-side
    // session-close hook fires only when a client sends one. This is the trigger that does not
    // depend on that: an MCP transport session with no request in this many minutes closes on
    // its own. Thirty is well past any real tool-call gap, and short enough that a transport a
    // client forgot to close does not sit in the session map for a whole shift.
    sessionIdleExpiryMinutes: ['AION_SESSION_IDLE_EXPIRY_MINUTES', positiveInt, 30],
  },
  logging: {
    filePath: [LOG_FILE_ENV_VAR, text, DEFAULT_LOG_FILE],
    level: [LOG_LEVEL_ENV_VAR, z.enum(LOG_LEVELS), DEFAULT_LOG_LEVEL],
  },
} as const satisfies KnobTable;

/** The widened view the runtime folds walk. `KNOBS` keeps the literal types `Config` is cut from. */
export const KNOB_TABLE: KnobTable = KNOBS;

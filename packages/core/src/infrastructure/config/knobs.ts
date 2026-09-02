import { z } from 'zod';

import { MAINTENANCE_KNOBS } from './maintenance-knobs.js';
import { TEMPORAL_KNOBS } from './temporal-knobs.js';
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
 * Four knobs are declared ahead of a reader: `recall.compressionThreshold`, unread until
 * narrative compression lands; `reflection.keyedCloseMode`, `temporal.readingHorizonDays`, and
 * `temporal.expiryAnnotation`, unread until the subject-keyed close and its read-side horizon
 * land. Each is here now because a knob added late is a knob whose name and range were never
 * reviewed, and setting one today changes nothing.
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
    // The embed model owns the vector space for the life of a substrate: stored vectors and the
    // graph's vector indexes are both sized by it, so changing it is a reset rather than a
    // restart, and an install holding vectors from another model pins both vars in .env until
    // it resets. `snowflake-arctic-embed2` returns 1024 floats and takes 8192 tokens. It was
    // picked against six other local models on name pairs drawn from a live proposal queue: it
    // held the widest gap between duplicate and distinct names and carries the widest window,
    // which is what raises the embed input cap.
    embed: ['AION_EMBED_MODEL', text, 'snowflake-arctic-embed2'],
    embedDimension: ['AION_EMBED_DIMENSION', positiveInt, 1024],
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
    // Twenty, raised from five. The cap cuts the fused list, deciding what survives fusion
    // competition rather than how big a pack gets: on a populated substrate (~40 episodes)
    // near-tie vector hits fill the first five, and the one traversal-reached item ranked 13th
    // is absent at 5, 8, and 12 and present at 20 (activation runs regardless). The token
    // budget, not this number, is what actually bounds a pack.
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
    // Whether a session is handed back memories made out of its own turns. On by default: a turn
    // is reflected into the graph at stop, and the next prompt's recall finds that turn and the
    // claims extracted from it as memories the session has never been served, while the
    // conversation that produced them is still holding every word. Off restores them, which is
    // what a caller inspecting what its own session wrote wants.
    ownSessionFilter: ['AION_RECALL_OWN_SESSION_FILTER', z.boolean(), true],
    // At `hebbian.weightFloor`, deliberately. Decay clamps a weight at the floor so a faded
    // pathway stays traversable, and a traversal cutoff above the floor would sever the whole
    // band the clamp exists to keep. Fading is proportional (spreading activation scales
    // propagation by strength); this number is only the point at which an edge counts as gone.
    associationStrength: ['AION_RECALL_ASSOCIATION_STRENGTH', proportion, 0.1],
    // The adjacency read's per-node cap: strongest edges only, taken after the strength
    // cutoff above. A live hub sat at degree 267 and growing; an ordinary node is far under
    // 64, so the cap changes nothing there and only trims what a hub was returning in full.
    adjacencyTopK: ['AION_RECALL_ADJACENCY_TOP_K', positiveInt, 64],
    compressionThreshold: ['AION_RECALL_COMPRESSION_THRESHOLD', positiveInt, 512],
    // A hang guard, not a latency target: the failure it catches is a call that never returns,
    // so it must not fire on ordinary calls. The cue model's cold-start round trip measured
    // 2288ms on host Ollama against 527-937ms warm, and 2000 still fired on an ordinary recall
    // at 2030ms, so the headroom a cold start needs is several multiples of the warm case.
    cueBudgetMs: ['AION_CUE_BUDGET_MS', positiveInt, 8000],
    tokenBudget: ['AION_RECALL_TOKEN_BUDGET', positiveInt, 1200],
    // Absolute cosine floors, measured against the embedding model's noise rather than pinned.
    // Against nomic-embed-text on 28 unrelated pairs and 10 genuine matches (`floors.fixtures.ts`):
    // unrelated p50 0.408, p95 0.530, max 0.547; related min 0.451, p50 0.773. The tails overlap,
    // so no floor separates them, and the answer to an overlap is corroboration rather than a lower
    // floor. `vectorAdmissionFloor` sits above the whole noise sample and admits one measurement
    // alone; a floor at 0.50 sat inside the overlap band and admitted off-topic text on one leg.
    // `corroborationFloor` is the lower bar a measurement clears to count as one of the two an item
    // can be corroborated on, and it too sits above the noise range: two readings at 0.46 and 0.51
    // are two readings of the same noise, which is what admitted every surviving item on the gate's
    // off-topic probes. `floor-calibration.int.test.ts` re-measures both and fails when the
    // committed values stop separating the distributions.
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
    // `restatementFloor` is the cosine at or above which a Goal or Plan is judged to be the query
    // said back rather than answered. Measured against nomic-embed-text on two distributions
    // of Goal/Plan text, both scored against the query that would retrieve them
    // (`facts.fixtures.ts`): nodes that restate the query min 0.841 p50 0.909, nodes that answer
    // it p50 0.552 max 0.729. 0.80 sits in the gap and caught 8 of 8 restatements with 0 of 8
    // misfires. `facts-calibration.int.test.ts` re-measures both and fails if they stop separating.
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
    // Typed-admission kill switch and floor; admission.ts's AdmissionPolicy has the reasoning.
    typedAdmission: ['AION_RECALL_TYPED_ADMISSION', z.boolean(), true],
    typedAdmissionActivationFloor: ['AION_TYPED_ADMISSION_ACTIVATION_FLOOR', proportion, 0.14],
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
    flushCeiling: ['AION_HEBBIAN_FLUSH_CEILING', positiveInt, 2_000],
    decayScanFraction: ['AION_HEBBIAN_DECAY_SCAN_FRACTION', proportion, 0.15],
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
    // The floor the bulk nominator's shared-episode Jaccard has to clear. A nomination floor,
    // not a decision line: everything above it is handed to the evidence tiers, and nothing
    // above it merges on this number alone. A tenth means the two were seen together in about
    // one episode in ten of the history they have between them, which is enough co-occurrence
    // to be worth reading and low enough that a rare name paired with a common one still gets
    // looked at. Sized against the community-size distribution of a live graph in 4.4; this
    // default is the starting point, not a measurement.
    entityNominationJaccardFloor: [
      'AION_REFLECTION_ENTITY_NOMINATION_JACCARD_FLOOR',
      proportion,
      0.1,
    ],
    // What the cascade's judge tier does with a pair both passes call one thing. `unanimous`
    // merges it; `propose` queues it and merges nothing, which makes it the kill switch. Tier 0
    // reads neither value: a squash-equality merge asks no model, so there is no judgment for a
    // mode over judgments to gate.
    // Set by measurement rather than by hand, on the pre-registered rule the battery prints:
    // auto-merge precision at or above 0.9 over the 24-pair cascade battery ships `unanimous`,
    // anything less ships `propose`, and `entity-cascade-precision.int.test.ts` asserts the
    // shipped value still matches what it measures, in both directions.
    // Measured 2026-09-01 against claude-haiku-4-5 with snowflake-arctic-embed2 embeddings,
    // 24 pairs built into a real graph: TP 8, FP 0, FN 4, TN 12, precision 1.000, recall 0.667.
    // Three merges came from tier 0, five from the judge, and four pairs went to the residue
    // lane. Every miss was a pair the second pass split rather than a wrong merge, which is the
    // shape the bar was written for. Precision held at 1.000 across three runs; recall moved
    // between 0.583 and 0.667 and gates nothing. The cross-type same-referent class is where
    // it is spent: a company and the product named after it reach the second pass, and the
    // second pass separates them.
    entityMergeMode: ['AION_ENTITY_MERGE_MODE', z.enum(['propose', 'unanimous']), 'unanimous'],
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
    // The default is set by measurement rather than by hand. The rule was pre-registered:
    // two-pass precision at or above 0.9 and recall at or above 0.9 on the 24-case battery
    // ships `unanimous`, anything less ships `propose`, and `supersession-precision.int.test.ts`
    // asserts the shipped value still matches what it measures, in both directions.
    // Measured 2026-08-30 against claude-haiku-4-5, 24 pairs: two-pass TP 12, FP 0, FN 0,
    // TN 12, precision 1.000, recall 1.000. The second pass saw 14 affirmatives and vetoed 2,
    // both on survival, both the false positives the single pass emitted (precision 0.857 on
    // the same run). The reviewer's prompt was written against those two shapes before the
    // measurement, which is a real risk of fitting the instrument: the number to watch is
    // whether it holds on pairs this set does not contain.
    supersedeMode: ['AION_SUPERSEDE_MODE', z.enum(['propose', 'auto', 'unanimous']), 'unanimous'],
    // The subject-keyed closure path's own switch, independent of `supersedeMode`: it runs
    // inside a different stage's write and needs to be killable on its own. `off` is the kill
    // switch and skips the keyed lookup entirely. `judge` routes a keyed candidate into the
    // same two-pass unanimous supersession judge `supersedeMode` uses, which closes it
    // autonomously. `close` is the mechanical keyed close, made in the writing transaction.
    // The default is set by measurement rather than by hand, on a rule pre-registered before
    // the numbers: precision at or above 0.95 over the 24-case keyed-close battery, made on at
    // least four mechanical closes, ships `close`; short of either it ships `judge`, and
    // `keyed-close-precision.int.test.ts` asserts the shipped value against what it measures,
    // in both directions. The bar is above the 0.9 the two judge batteries carry because this
    // is the one closure path with no second opinion behind it.
    // Measured 2026-09-01 against claude-haiku-4-5 with snowflake-arctic-embed2 embeddings, 24
    // pairs of sessions run through the shipped extraction stages: 2 closes, TP 2, FP 0, FN 6,
    // precision 1.000, recall 0.250. Both trap classes held, 6 of 6 and 6 of 6, and all four
    // sessions stating no single attribute kept every key off. What ships `judge` is the sample
    // and not the precision: 16 claims carried a key at all, 3 of the 24 cases carried one on
    // both halves, and the mechanism was therefore asked twice. The aspect slug is where the
    // recall goes. One case keyed the same entity from both sides and still missed, on
    // "checkpoint state storage location" against "checkpoint state storage backend"; every
    // other miss never keyed the earlier half at all. That is the number to move before this
    // is measured again.
    keyedCloseMode: ['AION_KEYED_CLOSE_MODE', z.enum(['off', 'judge', 'close']), 'judge'],
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
  // The `maintenance` table lives in its own file: it is the fastest-growing group (nearly
  // every introspection operation ships its own kill switch and batch here), and this file
  // sits at the 500-line lint cap with the least room to absorb that growth.
  maintenance: MAINTENANCE_KNOBS,
  // Split into its own file the same way `maintenance` is; see `temporal-knobs.ts` for why.
  temporal: TEMPORAL_KNOBS,
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

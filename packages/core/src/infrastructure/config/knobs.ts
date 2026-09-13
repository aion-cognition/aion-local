import { z } from 'zod';

import { nonNegativeInt, positive, positiveInt, proportion, text } from './knob-types.js';
import { MAINTENANCE_KNOBS } from './maintenance-knobs.js';
import { REFLECTION_KNOBS } from './reflection-knobs.js';
import { TEMPORAL_KNOBS } from './temporal-knobs.js';
import {
  DEFAULT_LOG_FILE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_FILE_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  LOG_LEVELS,
  LOG_RETENTION_ENV_VAR,
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

const searchMethod = z.enum(['vector', 'bm25', 'graph_traversal']);
const installProfile = z.enum(['docker', 'native']);

/**
 * Every knob the program has, declared once, as `leaf: [envVar, schema, value]`. The schema
 * tree, the default tree, and the flat AION_* catalog are all folded out of this table, so the
 * three cannot disagree, and the nesting is the config path: group, then leaf.
 *
 * One entry is one Config leaf and one env var, with `search.weights` the exception: a single
 * comma-separated var feeds all three sub-fields, which is what the trailing `'weights'`
 * declares.
 *
 * Two knobs cannot change anything yet. `recall.compressionThreshold` has no reader at all,
 * and waits on narrative compression. `recall.maxPreferences` is read and passed, but the
 * preferences bucket has no producer until preference extraction is built, so the cap bounds
 * a bucket that is structurally absent. Both are here now because a knob added late is a knob
 * whose name and range were never reviewed, and setting either today changes nothing.
 *
 * `redaction.entropyThreshold` and `operational.dataDir` have no pinned spec default; they
 * follow common secret-scanner practice (4.5 bits/char) and the compose data volume mount
 * point. `operational.workerCount` defaults to 1, one worker per process.
 */
export const KNOBS = {
  /**
   * Which substrate this install runs on, and the one knob that changes what `aion init`,
   * `aion doctor` and `aion status` are looking at rather than how they behave once they find
   * it. `docker` is the compose stack: init starts the two services and the addresses below
   * default to compose's own names. `native` is Neo4j and the MCP server as host processes,
   * where init verifies a Neo4j somebody else manages, writes a launchd job rather than
   * starting a container, and both stores are directories. It is a knob rather than a flag on
   * every command because doctor and status have to know which substrate to check without
   * being told again, and `aion init --install native` records it in `.env` for them.
   *
   * Nothing derives the addresses from it. `neo4j.uri`, `ollama.url`, `operational.dataDir`,
   * `sqlite.path` and `logging.filePath` keep their own defaults and their own env vars, and
   * the native install writes the values it needs into `.env` at init: a default that changed
   * shape under another knob would make every one of them unreadable from its own declaration.
   */
  install: {
    profile: ['AION_INSTALL_PROFILE', installProfile, 'docker'],
  },
  neo4j: {
    uri: ['AION_NEO4J_URI', text, 'bolt://neo4j:7687'],
    password: ['AION_NEO4J_PASSWORD', z.string(), ''],
  },
  ollama: {
    url: ['AION_OLLAMA_URL', text, 'http://host.docker.internal:11434'],
    // Seconds Ollama holds the embed model in memory after each embed call; -1 pins it
    // resident. The embed model serves every route and its reload lands inside the synchronous
    // recall hooks: measured against warm calls under a second, a reload added 1 to 16 seconds.
    embedKeepAlive: ['AION_EMBED_KEEP_ALIVE', z.number().int().min(-1), -1],
  },
  models: {
    // The embed model owns the vector space for the life of a substrate: stored vectors and the
    // graph's vector indexes are both sized by it, so changing it is a reset rather than a
    // restart, and an install holding vectors from another model pins both vars in .env until
    // it resets. `snowflake-arctic-embed2` returns 1024 floats and takes 8192 tokens. It was
    // picked against six other local models on name pairs drawn from a live proposal queue: it
    // held the widest gap between duplicate and distinct names and carries the widest window,
    // which is what raises the embed input cap. It is the only model Ollama serves here:
    // generation runs on the remote model named below.
    embed: ['AION_EMBED_MODEL', text, 'snowflake-arctic-embed2'],
    embedDimension: ['AION_EMBED_DIMENSION', positiveInt, 1024],
  },
  anthropic: {
    /**
     * Empty string means no generation. Capture, embeddings and every graph read still run; the
     * generation work queues and `aion status` says so. Nothing falls back to a local model.
     */
    apiKey: ['AION_ANTHROPIC_API_KEY', z.string(), ''],
    /** The model every generation names, whatever model the caller asked for. */
    model: ['AION_ANTHROPIC_MODEL', text, DEFAULT_ANTHROPIC_MODEL],
    promptCache: ['AION_ANTHROPIC_PROMPT_CACHE', z.boolean(), true],
    // Tokens a remote call that asked to reason may spend reasoning. Haiku 4.5 takes only the
    // manual extended-thinking mode, so this is a number rather than an effort word, and the
    // API's own floor is 1024. Two thousand is a ceiling and not a bill: the budget is a target
    // the model stops under, and a trivial probe measured 51 thinking tokens against a 1024
    // budget on 2026-09-13. The provider clamps it under the call's own max_tokens, since
    // thinking is billed and counted as output.
    thinkingBudgetTokens: ['AION_ANTHROPIC_THINKING_BUDGET_TOKENS', positiveInt, 2048],
    // Dollars of generation one UTC day may commit, across ordinary Messages calls and batch
    // submissions together. Every dispatch holds its own conservative maximum against it before
    // it is sent and replaces that with what it cost when the answer lands, so the number bounds
    // committed spend rather than reported spend. Past it, background work queues and recall
    // falls back to the raw query: exhaustion is generation being unavailable, the same shape a
    // substrate with no key already answers correctly, and not a failure anything retries.
    // Five is the retained W4 figure and is a backstop rather than a budget: the whole 2026-09-13
    // build round spent $5.12 across every chunk, so an ordinary day of use is nowhere near it
    // and a runaway loop reaches it in minutes.
    dailyCeilingUsd: ['AION_ANTHROPIC_DAILY_CEILING_USD', positive, 5],
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
    // Three, well under every other bucket's cap. The intentions bucket answers a question the
    // caller did not ask, so it is the one bucket whose cost is paid by every recall whether or
    // not it wanted one; three standing commitments is a reminder and a dozen is an agenda.
    maxIntentions: ['AION_RECALL_MAX_INTENTIONS', nonNegativeInt, 3],
    useContextResonance: ['AION_RECALL_USE_CONTEXT_RESONANCE', z.boolean(), true],
    // Whether a standing intention may come back on its own trigger rather than on the query.
    // Off skips the read and the match outright, which restores the pack exactly as it was
    // before intentions had triggers.
    intentionTriggers: ['AION_RECALL_INTENTIONS', z.boolean(), true],
    // The cosine between an intention's stored situation (its source episode's content vector)
    // and the centroid of what this recall activated, at or above which the situation counts as
    // the one the intention was filed in. It borrows `contextSearchThreshold`'s 0.5 rather than
    // being measured in its own right: the two comparisons are not the same one, since a
    // situation trigger reads an episode vector against a mean of context vectors, so this is a
    // starting value to re-derive rather than a calibrated floor. The entity and temporal
    // triggers are unaffected, which is what keeps the loosest of the three from being the only
    // one that fires.
    intentionSituationFloor: ['AION_RECALL_INTENTION_SITUATION_FLOOR', proportion, 0.5],
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
    cueCacheTtlMinutes: ['AION_CUE_CACHE_TTL_MINUTES', nonNegativeInt, 30],
    tokenBudget: ['AION_RECALL_TOKEN_BUDGET', positiveInt, 1200],
    // Absolute cosine floors, measured against the embedding model's noise rather than pinned.
    // Re-derived 2026-09-02 against snowflake-arctic-embed2 on 43 unrelated pairs and 10 genuine
    // matches (`floors.data.ts`): unrelated p50 0.086, p95 0.267, max 0.299; related min
    // 0.382, p05 0.438, p50 0.769. This model leaves a valley where nomic-embed-text left an
    // overlap, so the two floors split the 0.083 between the highest unrelated reading and the
    // weakest genuine match into three. `vectorAdmissionFloor` sits 0.032 under that weakest
    // match and admits one measurement alone. `corroborationFloor` is the lower bar a measurement
    // clears to count as one of the two an item can be corroborated on, and it sits 0.031 above
    // the whole noise sample: two readings inside the noise band are two readings of the same
    // noise, which is what admitted every surviving item on the gate's off-topic probes. Each
    // margin clears the 0.03 drift tolerance the calibration allows. The nomic-era pair was 0.60
    // and 0.55 against a noise sample that reached 0.547.
    // `floor-calibration.int.test.ts` re-measures both and fails when the committed values stop
    // separating the distributions.
    vectorAdmissionFloor: ['AION_VECTOR_ADMISSION_FLOOR', proportion, 0.35],
    corroborationFloor: ['AION_CORROBORATION_FLOOR', proportion, 0.33],
    /** A Lucene score is corpus-relative, so the lexical leg admits by rule, not by number. */
    bm25AdmissionMode: [
      'AION_BM25_ADMISSION_MODE',
      z.enum(['exact', 'corroborated', 'any']),
      'exact',
    ],
    // The name-similarity floor entity resolution's fuzzy leg seeds on, over the same `name_vec`
    // space the dedup nominator reads. Its own var, because borrowing
    // `contextResonance.contextSearchThreshold` would make one env var mean two unrelated things.
    // 0.7 is not re-derived: against the committed name-vector band (two names for one referent
    // min 0.367, p05 0.488, p50 0.760, background max 0.463) it cuts everything under the
    // same-referent p50, while the dedup nominator admits from 0.53 in that same space.
    entityMatchThreshold: ['AION_RECALL_ENTITY_MATCH_THRESHOLD', proportion, 0.7],
    // A near-duplicate cluster's cap on how many of its members one bucket may hold, after a
    // burst of near-identical episodes took 29.5% of a pack's slots. Two survivors keeps a
    // cluster's best-ranked content visible (a pack that answers "did we ever discuss X" still
    // gets one example) without one burst shape consuming the entire bucket.
    clusterCap: ['AION_PACK_CLUSTER_CAP', positiveInt, 2],
    // The cosine at which two items in one bucket are one cluster by vector rather than by their
    // shared prefix. Nomic-era, and strict for snowflake-arctic-embed2, where one assertion
    // written twice measures p50 0.929: the prefix key is what does most of the clustering.
    clusterCosineThreshold: ['AION_PACK_CLUSTER_COSINE_THRESHOLD', proportion, 0.95],
    // Whether a pack prints one assertion twice when the substrate holds it twice. On by
    // default. What counts as twice is identity of the stored text fold under one subject key,
    // never closeness of two vectors: measured against the shipped embedding model on claim
    // text, a sentence with a changed number reads 0.997 and a genuine rewording of one claim
    // reads 0.788, so the two populations are inverted and no floor separates them. Off skips
    // the read and the subtraction behind it, which restores the pack exactly as it was before
    // the third subtraction existed, and is what a caller auditing what the substrate stores
    // wants.
    packDuplicateSuppression: ['AION_PACK_DUPLICATE_SUPPRESSION', z.boolean(), true],
    // The facts bucket's own three rules, after entity glosses took 58% of fact slots and
    // Decision nodes 3% on a decision-oriented workload. `entityGlossCap` bounds the glosses at
    // four: a pack that answers "who is involved in X" needs room for more than one name while
    // still leaving eleven of fifteen fact slots to content that states something.
    entityGlossCap: ['AION_PACK_ENTITY_GLOSS_CAP', positiveInt, 4],
    // `restatementFloor` is the cosine at or above which a Goal or Plan is judged to be the query
    // said back rather than answered. Re-derived 2026-09-02 against snowflake-arctic-embed2 on
    // two distributions of Goal/Plan text, both scored against the query that would retrieve them
    // (`facts.fixtures.ts`): nodes that restate the query min 0.723 p50 0.841 max 0.907, nodes
    // that answer it p50 0.404 p95 0.653 max 0.656. 0.69 is the midpoint of that gap, 0.033 above
    // the strongest answering node and 0.033 under the weakest restatement, both margins at the
    // 0.03 drift tolerance, and it catches 8 of 8 restatements with 0 of 8 misfires. The nomic-era
    // value was 0.80 against a restating band that started at 0.841.
    // `facts-calibration.int.test.ts` re-measures both and fails if they stop separating.
    restatementFloor: ['AION_FACTS_RESTATEMENT_FLOOR', proportion, 0.69],
    // `decisionBoost` multiplies the fused score of Decision and Insight when the cue model
    // judged the query decision-shaped. At rrfConstant 60 a factor of 1.25 is worth about
    // fifteen ranks, which is the facts cap: enough to bring a Decision any leg ranked into the
    // bucket, not enough to let one no leg ranked displace the top hit.
    decisionBoost: ['AION_DECISION_INTENT_BOOST', z.number().min(1), 1.25],
    // Cosine at or above which the current claim in a raw turn's subject family is printed
    // beside the turn. The family match has already established that the two name the same
    // subject; this keeps a claim that merely shares a name off the item. 0.55 is the
    // nomic-embed-text floor, set above that model's unrelated sample, which reached 0.547.
    // It is not re-derived against snowflake-arctic-embed2, whose unrelated sample tops out at
    // 0.299, so the floor now sits 0.25 above the noise it was drawn against and is likely
    // cutting genuine turn-to-claim pairs. The pair it was built for measured 0.79 turn to
    // claim under nomic, and the next claim in the same family 0.68.
    relatedClaimFloor: ['AION_RELATED_CLAIM_FLOOR', proportion, 0.55],
    // Typed-admission kill switch and floor; admission.ts's AdmissionPolicy has the reasoning.
    typedAdmission: ['AION_RECALL_TYPED_ADMISSION', z.boolean(), true],
    typedAdmissionActivationFloor: ['AION_TYPED_ADMISSION_ACTIVATION_FLOOR', proportion, 0.14],
    // The disclosed path-strength lane's own budget: how many activation-only arrivals with no
    // qualifying cosine and no exact match may still reach a pack, per pack, on the strength of
    // their own accumulated activation alone (`fusion.ts`'s `admitByPathStrength`). The floor
    // policy above is unchanged either way; this is a separate, bounded door rather than a
    // second floor. 2 by Ryan's word in the recalibration plan: enough to disclose a genuine
    // graph-only find without competing for the floors' own slots. 0 turns the lane off and
    // leaves a pack byte-identical to one built before it existed.
    pathStrengthSlots: ['AION_RECALL_PATH_STRENGTH_SLOTS', nonNegativeInt, 2],
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
    // How long a reinforcement signal waits for the first batch that could claim it. Five
    // seconds is the paper's cadence, run on the existing batch machinery rather than beside
    // it: the flush already drains toward `flushCeiling` in `batchSize` batches, so this is
    // the wait before the first of those and not a second bound on the work. It is a cadence
    // and not a guarantee, since no bounded drain empties a queue arrival outruns; the queue's
    // own rolling cap and its dropped counter are what say when that happens.
    drainIntervalMs: ['AION_HEBBIAN_DRAIN_INTERVAL_MS', positiveInt, 5_000],
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
    // The cosine between two neighborhood shapes at which the second pass calls one a match. A
    // different space from the content floors, and it is measured in its own space: re-derived
    // 2026-09-02 against snowflake-arctic-embed2 on the resonance gate's three worlds
    // (`context-resonance.int.test.ts` prints all of it). A neighborhood shaped like the one the
    // query anchored reads 0.785 against it, and the three items the bucket admitted read 0.776,
    // 0.705 and 0.703 against the centroid; the world whose crew has a different shape reads
    // 0.308. 0.5 is the midpoint, 0.192 above the mismatch and 0.203 under the weakest match,
    // and it still sits above `recall.vectorAdmissionFloor`, so the bucket stays a second way in
    // rather than a lower one. The nomic-era value was 0.7, against shape matches that ran 0.95
    // and up in that model's space.
    contextSearchThreshold: ['AION_CONTEXT_RESONANCE_CONTEXT_SEARCH_THRESHOLD', proportion, 0.5],
  },
  reflection: REFLECTION_KNOBS,
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
  // The `maintenance` table lives in its own file: it is the fastest-growing group (most
  // introspection operations ship a batch bound there, and about half ship a kill switch),
  // and this file sits at the 500-line lint cap with the least room to absorb that growth.
  maintenance: MAINTENANCE_KNOBS,
  // Split into its own file the same way `maintenance` is; see `temporal-knobs.ts` for why.
  temporal: TEMPORAL_KNOBS,
  sqlite: {
    path: [SQLITE_PATH_ENV_VAR, text, DEFAULT_SQLITE_PATH],
    // Rows past this are dropped oldest-first at enqueue. The drain empties the table on its own
    // cadence (`hebbian.drainIntervalMs`), so the cap bounds what accumulates between two drains.

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
    // Days of file log kept, fractions allowed. One day, because this file is the tail somebody
    // reads after something went wrong rather than an archive: a substrate's durable history is
    // the graph and the experience store, and neither is here. Enforced wherever a logger opens,
    // so both profiles get it; at most the current window and the one before it are on disk.
    retentionDays: [LOG_RETENTION_ENV_VAR, positive, DEFAULT_LOG_RETENTION_DAYS],
  },
} as const satisfies KnobTable;

/** The widened view the runtime folds walk. `KNOBS` keeps the literal types `Config` is cut from. */
export const KNOB_TABLE: KnobTable = KNOBS;

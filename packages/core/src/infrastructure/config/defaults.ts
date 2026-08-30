import { DEFAULT_LOG_FILE, DEFAULT_LOG_LEVEL } from '../logging/logger.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic-provider.js';
import { DEFAULT_SQLITE_PATH } from '../sqlite/database.js';
import { DEFAULT_REINFORCEMENT_QUEUE_CAP } from '../sqlite/reinforcement-queue.js';
import type { Config } from './schema.js';

/**
 * `redaction.entropyThreshold` and `operational.dataDir` have no pinned spec default;
 * they follow common secret-scanner practice (4.5 bits/char) and the compose data
 * volume mount point respectively. `operational.workerCount` defaults to 1, one worker
 * per process. Three values below depart from a smaller candidate default; each says why
 * at the line.
 *
 * Reserved knobs: `recall.compressionThreshold` is declared and overridable but has no
 * reader yet, since narrative compression lands later. It is declared now because the
 * catalog is one document, and a knob added late is a knob whose name and range were never
 * reviewed; setting one today changes nothing. The context resonance and `hebbian.*` knobs
 * were reserved the same way and now have readers: the recall second pass, the reinforcement
 * flush, and the decay sweep. `maintenance.tier3` now gates the introspector's tier-3 seam,
 * which consults the advisor and records what it would have been asked; the model call
 * itself is still unbuilt, so turning it on changes what is logged and nothing that runs.
 */
export const DEFAULTS: Config = {
  neo4j: {
    uri: 'bolt://neo4j:7687',
    password: '',
  },
  ollama: {
    url: 'http://host.docker.internal:11434',
    mode: 'baremetal',
  },
  models: {
    embed: 'nomic-embed-text',
    embedDimension: 768,
    cue: 'qwen3:1.7b',
    reflect: 'qwen3:8b',
  },
  anthropic: {
    apiKey: '',
    model: DEFAULT_ANTHROPIC_MODEL,
  },
  routing: {
    cue: 'auto',
    reflect: 'auto',
  },
  recall: {
    // Raised from 2 to 3: the cross-session graph routes every path through a Session hub.
    // Episode -PARTICIPATES_IN-> Session -FOLLOWS-> Session -PARTICIPATES_IN-> Episode is
    // three hops, so at 2 the FOLLOWS chain reaches nothing but a contentless Session node.
    // The resonance spread elsewhere uses 3 for the same reason.
    maxHops: 3,
    vectorLimit: 5,
    maxFacts: 15,
    // Raised from 5 to 20. The cap cuts the fused list, so it decides what survives fusion
    // competition rather than how big a pack gets: on a populated substrate (~40 episodes)
    // near-tie vector hits fill the first five, and the one traversal-reached item ranked
    // 13th is absent at 5, 8, and 12 and present at 20. Activation runs on every recall
    // either way; the cap decides whether the caller sees what it found. The token budget,
    // not this number, is what actually bounds a pack.
    maxEpisodes: 20,
    maxNarratives: 5,
    maxPreferences: 3,
    maxResonant: 5,
    useContextResonance: true,
    // At `hebbian.weightFloor`, deliberately. Decay clamps a weight at the floor so a faded
    // pathway stays traversable, and a traversal cutoff above the floor would sever the whole
    // band the clamp exists to keep. Fading is proportional (spreading activation scales
    // propagation by strength); this number is only the point at which an edge counts as gone.
    associationStrength: 0.1,
    compressionThreshold: 512,
    // 8000 because a hang guard must not fire on ordinary calls. The cue model's cold-start
    // round trip measured 2288ms on host Ollama against 527-937ms warm, and a guard that
    // fires on the first recall after a model eviction degrades the stage it exists to
    // protect. A lower value of 2000 still fired on an ordinary recall at 2030ms: warm cue
    // latency runs 558-811ms, so the headroom a cold start needs is several multiples of
    // the warm case. Still a hang guard, not a latency target: the failure this catches is
    // a call that never returns.
    cueBudgetMs: 8000,
    tokenBudget: 1200,
    // Measured, not pinned. Against nomic-embed-text on 28 unrelated pairs and 10 genuine
    // matches (`floors.fixtures.ts`): unrelated p50 0.408, p95 0.530, max 0.547; related min
    // 0.451, p50 0.773. The tails overlap, so no floor separates them, and the pin's answer to
    // an overlap is corroboration rather than a lower floor: the floor sits above the whole
    // noise sample and the two genuine matches inside the band (0.451, 0.588) are admitted by
    // two agreeing legs instead. A floor at 0.50 sat inside that band and admitted off-topic
    // text on one leg, which would fill result packs beyond their capacity.
    vectorAdmissionFloor: 0.6,
    // Above the noise sample's whole range (max 0.547), not merely above its median. A
    // corroborating measurement is still a measurement, and two of them at 0.46 and 0.51 are
    // two readings of the same noise, not two legs agreeing: on the gate's off-topic probes
    // that is exactly what admitted every surviving item, each one under the floor on its own.
    // What the band between this and the floor buys is a genuine match no single cue phrased
    // well enough, admitted when two independent cues both put it above the noise.
    corroborationFloor: 0.55,
    bm25AdmissionMode: 'exact',
    entityMatchThreshold: 0.7,
    // Two survivors keeps a cluster's best-ranked content visible
    // (a pack that answers "did we ever discuss X" still gets one example) without one
    // burst shape consuming the entire bucket.
    clusterCap: 2,
    // Four: a pack that answers "who is involved in X" needs room for more than one name
    // while still leaving eleven of fifteen fact slots to content that states something.
    entityGlossCap: 4,
    // Measured against nomic-embed-text on two distributions of Goal/Plan text, both scored
    // against the query that would retrieve them (`facts.fixtures.ts`): nodes that restate the
    // query min 0.841 p50 0.909, nodes that answer it p50 0.552 max 0.729. 0.80 sits in the gap
    // between them and caught 8 of 8
    // restatements with 0 of 8 misfires. `facts-calibration.int.test.ts` re-measures both and
    // fails if they stop separating.
    restatementFloor: 0.8,
    // At rrfConstant 60 a factor of 1.25 is worth about fifteen ranks, which is the facts cap:
    // enough to bring a Decision any leg ranked into the bucket, not enough to let one no leg
    // ranked displace the top hit.
    decisionBoost: 1.25,
  },
  search: {
    methods: ['vector', 'bm25', 'graph_traversal'],
    reranker: 'rrf',
    rrfConstant: 60,
    mmrLambda: 0.5,
    weights: {
      vector: 0.4,
      bm25: 0.3,
      graph: 0.3,
    },
  },
  activation: {
    maxIterations: 100,
    decayFactor: 0.7,
    minActivation: 0.1,
    maxNodesVisited: 500,
    hubThreshold: 10,
  },
  hebbian: {
    weightFloor: 0.1,
    learningRate: 0.1,
    decayRate: 0.05,
    decayPeakDays: 30,
    decaySigma: 15,
    batchSize: 100,
    flushIntervalMs: 5000,
  },
  contextResonance: {
    // The cap on the scaled seed budget, raised from 10, which used to be the whole budget.
    // Ten seeds are the entire candidate set, so on a substrate of several thousand memories
    // a node that answers the query above the admission floor was never measured, because it
    // was never a candidate. The curve below reaches this ceiling near sixty thousand memory
    // nodes and stays under `activationLimit`, so the spread still has room to return
    // something the seeds did not already carry.
    seedLimit: 32,
    seedBudgetBase: 10,
    seedBudgetGrowth: 2,
    activationLimit: 50,
    resonantLimit: 20,
    maxHops: 3,
    activationThreshold: 0.1,
    contextSearchThreshold: 0.7,
  },
  /**
   * Every value is the pinned default its stage already carries as a module constant, and
   * `reflection-defaults.test.ts` asserts the two agree: config is where a knob is named and
   * ranged, the stage is where it is used, and a silent divergence between them would ship a
   * pipeline nobody configured. Two values, `supersedeAutoConfidence` (0.85) and
   * `associationSemanticThreshold` (0.75), have no stage-owned constant to match against.
   */
  reflection: {
    entityTimeoutMs: 60_000,
    maxEntities: 32,
    entityDedupThreshold: 0.85,
    associationSemanticThreshold: 0.75,
    associationSimilarLimit: 5,
    cognitiveTimeoutMs: 60_000,
    maxCognitiveNodes: 20,
    semanticTimeoutMs: 60_000,
    maxRelationships: 40,
    supersedeMode: 'propose',
    supersedeAutoConfidence: 0.85,
    supersedeNeighborThreshold: 0.75,
    // Under the neighbour threshold, because these two claims already share an observation and
    // a named subject: the evidence a family close needs on top of that is that they are about
    // the same thing, not that they nearly restate each other.
    supersedeFamilyRelatednessFloor: 0.6,
    supersedeTimeoutMs: 60_000,
    maxSupersessionSubjects: 6,
    maxContradictionNeighbors: 3,
    maxContradictionJudgments: 8,
    narrativeIdleMinutes: 30,
    narrativeTimeoutMs: 60_000,
    maxNarrativeEpisodes: 40,
    maxNarrativeEpisodeChars: 2_000,
    narrativeSweepLimit: 20,
  },
  /**
   * Measured against the live incident: four uncapped harnesses pushed ~4,100 episodes in
   * ten minutes across eight sessions, roughly 51 arrivals per session per minute and 410
   * globally. `sessionArrivalMax` is 2 per minute, so that pattern demotes inside the first
   * few seconds, while a session-end flush of ten episodes at once does not. `globalArrivalMax`
   * is twelve busy sessions' worth: past it the substrate is hot and each session's allowance
   * drops to `hotSessionArrivalMax`, which is what stops enough fresh sessions from
   * reproducing the flood with every per-session counter reading green.
   */
  lanes: {
    arrivalWindowMs: 300_000,
    sessionArrivalMax: 10,
    globalArrivalMax: 120,
    hotSessionArrivalMax: 3,
  },
  redaction: {
    entropyThreshold: 4.5,
  },
  maintenance: {
    tier3: false,
    // Fifteen minutes is one bucket of the finest granularity an operation can declare, so
    // every operation gets at least one chance per window it is allowed to run in.
    tickMinutes: 15,
    // Two hours of ticks. An operation with real but small relevance reaches the threshold
    // inside a working session rather than inside a week.
    starvationCycles: 8,
    urgencyThreshold: 0.2,
    // The deprioritization line: at or above it an operation scores at full weight, under
    // it at half, and starvation still eventually runs it either way.
    effectivenessFloor: 0.5,
    // At hebbian.batchSize's own default: a content-vector backfill is the same shape of
    // work as a reinforcement flush, one bounded pass over a pending queue.
    vectorBackfillBatchSize: 100,
    // A fifth of the content-vector batch. Context staleness is a quality gap the next
    // pipeline run corrects anyway, not a hole in vector search, so each tick spends little
    // on it.
    contextRefreshBatchSize: 20,
    reconcileBatchSize: 200,
    deadLetterBatchSize: 50,
    // Small: every hit rewrites a live node property, and a wrong redaction destroys
    // content permanently since nothing in the substrate is hard-deleted.
    redactionPurgeBatchSize: 20,
    // Sessions, not narratives: a session with duplicates costs one supersede per straggler,
    // a stale one a regeneration call, so ten sessions is a modest tick even at the worst mix.
    narrativeCleanupBatch: 10,
    // Each episode costs up to eight judgment calls (supersession's own ceiling), so five
    // keeps one tick's model spend in line with an ordinary reflection run.
    retroSupersessionBatch: 5,
    // Each entity costs one generation call and one embed. Small on purpose: a refresh a
    // tick behind is a staleness window, not an outage.
    descriptionRefreshBatch: 3,
    // Five new mentions since the description was written is enough traffic to plausibly
    // have added something worth folding in, without refreshing on every other mention.
    descriptionRefreshMentionGrowth: 5,
    // One indexed lookup and one edge write per break, which is the cheapest repair in the
    // catalog, so the batch matches the orphan sweep it sits beside.
    backboneRepairBatch: 200,
    // Two graph reads and at most one small write per orphan, so a couple of hundred is a
    // tick's work even when every one of them needs a repair.
    orphanCleanupBatch: 200,
    // A month with no candidate and no new edge. Anything the pipeline was going to attach
    // has long since attached, and forgetting is reversible in the sense that matters here:
    // the node stays readable under `as_of`.
    orphanForgetAfterDays: 30,
    // The projection is in-memory and all-or-nothing. Twenty thousand nodes is well past a
    // laptop-scale substrate and still inside a heap the compose file caps at 1G.
    communityNodeLimit: 20_000,
    // The same floor the critical rules use: under twenty nodes, communities describe noise.
    communityMinNodes: 20,
    // Three members is the smallest group that can be a neighbourhood rather than a pair.
    bridgeMinCommunitySize: 3,
    // One crossing edge for every four members of the smaller side. Below that the two are
    // joined by a thread; at or above it activation already has a way across and a bridge
    // would be a write that buys nothing.
    bridgeOverlapCeiling: 0.25,
  },
  sqlite: {
    path: DEFAULT_SQLITE_PATH,
    reinforcementQueueCap: DEFAULT_REINFORCEMENT_QUEUE_CAP,
  },
  operational: {
    dataDir: '/data',
    mcpPort: 8765,
    workerCount: 1,
    workerStaleClaimTimeoutMs: 600_000,
    workerRetryBaseMs: 5_000,
    workerRetryCapMs: 300_000,
    workerMaxAttempts: 5,
    workerBreakerThreshold: 5,
    workerBreakerCooldownMs: 60_000,
    workerVectorBatchSize: 64,
    reconcileWarnThreshold: 50,
    // Ten minutes clears the drain rate measured against the live substrate
    // (1.9 to 6.7 episodes/min) is a real backlog, not noise; 200 unclaimed is the same
    // judgment by depth instead of age.
    lagOldestUnclaimedWarnMs: 600_000,
    lagQueueDepthWarnThreshold: 200,
    // Well past any real tool-call gap, short enough that a
    // transport a client forgot to close does not sit in the session map for a whole shift.
    sessionIdleExpiryMinutes: 30,
  },
  logging: {
    filePath: DEFAULT_LOG_FILE,
    level: DEFAULT_LOG_LEVEL,
  },
};

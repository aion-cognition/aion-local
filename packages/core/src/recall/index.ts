/**
 * The recall layer's public surface: the pipeline, its stages, and the pure domain modules
 * behind admission, fusion, ranking and pack assembly.
 */

export { CueCache, extractCues } from './application/cues.js';
export type {
  CueExtractionDeps,
  CueExtractionInput,
  CueExtractionResult,
} from './application/cues.js';

export {
  CALIBRATION_TOLERANCE,
  checkSeparation,
  describeDistribution,
  pairedCosines,
  pairwiseCosines,
  percentile,
} from './domain/floor-calibration.js';
export type { Distribution, Separation, SeparationInput } from './domain/floor-calibration.js';
export { measureAdmissionFloor } from './application/floor-check.js';
export {
  BATTERY_SUBSTRATE,
  OFF_TOPIC_BATTERY,
  ON_TOPIC_BATTERY,
  RELATED_PAIRS,
  UNRELATED_PAIRS,
  UNRELATED_SENTENCES,
  WEAK_RELATED_PAIRS,
} from './application/floors.fixtures.js';
export type { BatteryEpisode, OnTopicProbe, ScoredPair } from './application/floors.fixtures.js';

export {
  SEED_STRATEGIES,
  mergeSeeds,
  normalizeToBest,
  recencyScore,
  scaleByCueWeight,
  selectSeeds,
} from './application/seeds.js';
export type {
  Seed,
  SeedContribution,
  SeedCue,
  SeedProvenance,
  SeedSelection,
  SeedStrategy,
  SelectSeedsDeps,
  SelectSeedsInput,
} from './application/seeds.js';

export {
  SEED_ACTIVATION,
  SUPERSEDED_ACTIVATION_WEIGHT,
  edgeWeight,
  hubInhibition,
  spreadActivation,
} from './domain/activation.js';
export type {
  ActivatedNode,
  ActivationBudget,
  ActivationRun,
  ActivationSeed,
  ActivationTermination,
  AdjacencyFetch,
  SpreadActivationInput,
} from './domain/activation.js';

export {
  buildRankedLists,
  seedCandidate,
  toActivationSeed,
  traversalCandidates,
} from './application/candidates.js';
export type { RankedListInput, TraversalInput } from './application/candidates.js';

export { SUPERSEDED_RANK_WEIGHT, fuse, reciprocalRank } from './domain/fusion.js';
export { applyClusterCap, cosineSimilarity, mmrOrder } from './domain/ranking.js';
export type { RankableItem } from './domain/ranking.js';
export type {
  FusedItem,
  FusionCandidate,
  FusionLeg,
  FusionOptions,
  FusionResult,
  RankedList,
} from './domain/fusion.js';

export { absoluteRelevance, admissionEvidence, admitsOnEvidence } from './domain/admission.js';
export type {
  AdmissionEvidence,
  AdmissionPolicy,
  AdmissionReport,
  Bm25AdmissionMode,
  Measurement,
} from './domain/admission.js';

export { CHARS_PER_TOKEN, assemblePack, estimateTokens, packMethods } from './domain/pack.js';
export type { AssemblePackInput } from './domain/pack.js';
export { PACK_BUCKETS, bucketFor } from './domain/pack-buckets.js';
export type { BucketCaps, PackBucket } from './domain/pack-buckets.js';

export {
  DECISION_INTENT_LABELS,
  GLOSS_LABEL,
  RESTATEMENT_LABELS,
  hasDecisionIntent,
  labelBoosts,
  queryCueTexts,
  queryRestatements,
} from './domain/facts.js';
export type { RestatementCandidate, RestatementPolicy } from './domain/facts.js';

export {
  ANSWERING_GOALS,
  DECISION_SUBSTRATE,
  DECISION_PROBE,
  RESTATING_GOALS,
} from './application/facts.fixtures.js';
export type { FactsPair, SubstrateNode } from './application/facts.fixtures.js';

export { RESONANCE_PATH, contextCentroid, resonantItem } from './domain/resonance.js';
export type { ActivationWeight } from './domain/resonance.js';
export { resonate } from './application/resonance.js';
export type {
  ResonanceDeps,
  ResonanceInput,
  ResonanceResult,
  ResonanceSkip,
} from './application/resonance.js';

export { handleRecall, readModeFor } from './application/recall.js';
export type {
  RecallCompletion,
  RecallDeps,
  RecallListener,
  RecallOptions,
} from './application/recall.js';

export {
  REINFORCEMENT_TOP_N,
  REINFORCEMENT_TRIGGER,
  RecallSideEffects,
  reinforcementPairs,
} from './application/side-effects.js';

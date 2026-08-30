/**
 * The recall layer's public surface: the pipeline, its stages, and the pure domain modules
 * behind admission, fusion, ranking and pack assembly.
 */

export { CueCache } from './application/cues.js';

export { measureAdmissionFloor } from './application/floor-check.js';
export {
  BATTERY_SUBSTRATE,
  OFF_TOPIC_BATTERY,
  ON_TOPIC_BATTERY,
} from './application/floors.fixtures.js';

export { selectSeeds } from './application/seeds.js';
export type { Seed, SeedCue } from './application/seeds.js';

export { cosineSimilarity } from './domain/ranking.js';
export type { FusedItem } from './domain/fusion.js';

export type { AdmissionReport } from './domain/admission.js';

export { assemblePack } from './domain/pack.js';
export { PACK_BUCKETS } from './domain/pack-buckets.js';
export type { BucketCaps, PackBucket } from './domain/pack-buckets.js';

export { RESONANCE_PATH } from './domain/resonance.js';

export { handleRecall } from './application/recall.js';
export type { RecallCompletion, RecallDeps } from './application/recall.js';

export { RecallSideEffects } from './application/side-effects.js';

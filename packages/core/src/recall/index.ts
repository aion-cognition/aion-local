/**
 * The recall layer's public surface: the pipeline with its cue cache, seed selection and side
 * effects; the pack taxonomy, its assembly and the resonant path marker; the admission and
 * fusion result types with the cosine behind them; and the floor re-measurement the doctor
 * runs, with the batteries the gate reads.
 */

export { CueCache } from './application/cues.js';

export { measureAdmissionFloor } from './application/floor-check.js';
export {
  BATTERY_SUBSTRATE,
  OFF_TOPIC_BATTERY,
  ON_TOPIC_BATTERY,
} from './application/floors.data.js';

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

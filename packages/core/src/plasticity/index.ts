/**
 * The plasticity layer's public surface: the Hebbian update math and the flush operation the
 * introspector schedules.
 */

/**
 * The two trigger strings stay off this barrel. Each producer's own layer already exports the
 * string it writes, and re-exporting the same name from two layers makes it ambiguous at the
 * package entrypoint.
 */
export {
  DEFAULT_TRIGGER_POLICY,
  TRIGGER_POLICIES,
  aggregateWindow,
  boundedReinforcement,
  cliqueDiscount,
  cliqueSizes,
  pairKey,
  signalGroupKey,
  signalWeight,
  triggerPolicy,
} from './domain/reinforcement.js';
export type { AggregatedPair, QueuedSignal, TriggerPolicy } from './domain/reinforcement.js';

export {
  DEFAULT_HEBBIAN_BATCH_SIZE,
  DEFAULT_HEBBIAN_LEARNING_RATE,
  DEFAULT_HEBBIAN_WEIGHT_FLOOR,
  flushReinforcementQueue,
} from './application/flush.js';
export type {
  HebbianFlushDeps,
  HebbianFlushOptions,
  HebbianFlushReport,
} from './application/flush.js';

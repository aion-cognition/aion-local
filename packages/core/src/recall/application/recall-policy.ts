import type { PackTruncation } from '@aion/protocol';

import type { Config } from '../../infrastructure/config/schema.js';
import type { ActivationBudget, ActivationTermination } from '../domain/activation.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import type { BucketCaps } from '../domain/pack-buckets.js';

/**
 * The four shapes the pipeline reads off the config, split out of `recall.ts` so that file
 * stays the stage order. None of them decides anything on its own: each is one knob group in
 * the shape the stage that consumes it takes.
 */

export function admissionFor(config: Config): AdmissionPolicy {
  return {
    vectorFloor: config.recall.vectorAdmissionFloor,
    corroborationFloor: config.recall.corroborationFloor,
    bm25Mode: config.recall.bm25AdmissionMode,
    typedAdmissionEnabled: config.recall.typedAdmission,
    typedAdmissionActivationFloor: config.recall.typedAdmissionActivationFloor,
  };
}

export function capsFor(config: Config): BucketCaps {
  return {
    facts: config.recall.maxFacts,
    episodes: config.recall.maxEpisodes,
    narratives: config.recall.maxNarratives,
    intentions: config.recall.maxIntentions,
    preferences: config.recall.maxPreferences,
    resonant: config.recall.maxResonant,
  };
}

export function activationBudget(config: Config): ActivationBudget {
  return {
    ...config.activation,
    maxHops: config.recall.maxHops,
    associationStrength: config.recall.associationStrength,
    maxActivated: config.contextResonance.activationLimit,
  };
}

/**
 * Which terminations mean the answer was cut short. `hop_limit` is not one of them: traversal
 * depth is bounded by design, so stopping there is the spread finishing its job. The other two
 * are budgets. `node_budget` measured on 60.2% of recalls against a populated substrate,
 * invisible to every caller.
 */
export function truncationFor(termination: ActivationTermination): PackTruncation | undefined {
  if (termination === 'node_budget' || termination === 'max_iterations') {
    return 'activation_budget';
  }
  return undefined;
}

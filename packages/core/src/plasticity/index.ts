/**
 * The plasticity layer's public surface: the Hebbian update math and the flush operation the
 * introspector schedules.
 */

/**
 * The two trigger strings stay off this barrel. Each producer's own layer already exports the
 * string it writes, and re-exporting the same name from two layers makes it ambiguous at the
 * package entrypoint.
 */

export { plasticityCounters } from './application/metrics.js';
export type { PlasticityCounters } from './application/metrics.js';

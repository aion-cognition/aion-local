/**
 * The plasticity layer's public surface: the counters the CLI and the MCP snapshot read.
 *
 * The flush, the decay sweep and the Hebbian math stay off this barrel. Only introspection
 * calls them, and it imports them by relative path. The drain's owner and its cadence are the
 * exception: the service starts the cadence and hands the owner to the catalog, so both names
 * are read from outside core.
 */

/**
 * The trigger strings stay off it for the same reason. `domain/reinforcement.ts` declares each
 * one, the two producers that write it import it from there, and nothing outside core reads a
 * trigger.
 */

export { plasticityCounters } from './application/metrics.js';
export type { PlasticityCounters } from './application/metrics.js';

export { ReinforcementCadence, reinforcementDrain } from './application/drain.js';

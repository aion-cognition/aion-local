import { KNOB_TABLE } from './knobs.js';
import type { Config } from './schema.js';

/**
 * Folds the knob table's third tuple slot into the shipped tree. `KNOBS` states why a stage reads
 * its value from here rather than restating it.
 *
 * Every value is cloned. `Config` strips the table's readonly modifiers, so a caller writing to
 * `DEFAULTS.search.weights` would otherwise be writing into the declaration itself, for the life
 * of the process.
 */
function buildDefaults(): Config {
  const config: Record<string, Record<string, unknown>> = {};
  for (const [group, leaves] of Object.entries(KNOB_TABLE)) {
    const section: Record<string, unknown> = {};
    for (const [leaf, [, , value]] of Object.entries(leaves)) {
      section[leaf] = structuredClone(value);
    }
    config[group] = section;
  }
  return config as unknown as Config;
}

export const DEFAULTS: Config = buildDefaults();

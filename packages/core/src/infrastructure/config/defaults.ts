import { KNOB_TABLE } from './knobs.js';
import type { Config } from './schema.js';

/**
 * The shipped value of every knob, folded out of the one table that declares them. This is the
 * one home for every number a reflection stage or the worker runs on: a stage takes its value as
 * a constructor option and falls back to the leaf here, so a knob and the pipeline that reads it
 * cannot disagree. Before, each stage restated its own copy and a test asserted the two matched.
 */
function buildDefaults(): Config {
  const config: Record<string, Record<string, unknown>> = {};
  for (const [group, leaves] of Object.entries(KNOB_TABLE)) {
    const section: Record<string, unknown> = {};
    for (const [leaf, [, , value]] of Object.entries(leaves)) {
      section[leaf] = value;
    }
    config[group] = section;
  }
  return config as unknown as Config;
}

export const DEFAULTS: Config = buildDefaults();

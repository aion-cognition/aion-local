/**
 * A layer barrel carries only what something outside core imports, and the infrastructure barrel
 * re-exports exactly these four. The registry, the schema, and the knob tables are reached by
 * their own modules from inside this directory.
 */
export type { Config } from './schema.js';
export { DEFAULTS } from './defaults.js';
export { loadConfig, ConfigError } from './load-config.js';

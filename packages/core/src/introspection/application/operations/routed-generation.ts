import type { Config } from '../../../infrastructure/config/schema.js';
import { ProviderRouter } from '../../../infrastructure/providers/role-provider.js';
import type { Provider } from '../../../infrastructure/providers/types.js';

/**
 * The generation these operations need — supersession judgments, entity description
 * re-synthesis — is reflection-shaped: off the hot path, over stored text, at reflection's
 * own cadence. It follows the `reflect` role, the same key-routing every reflection stage
 * gets, rather than opening a maintenance role of its own. A router is cheap to build (no I/O
 * until a call is made), so each run constructs its own rather than the engine threading one
 * through every operation's context for the two that need it.
 */
export function reflectProvider(config: Config): Provider {
  return new ProviderRouter({ config }).forRole('reflect');
}

/** The seam a test substitutes to avoid a live model call. */
export type ProviderFactory = (config: Config) => Provider;

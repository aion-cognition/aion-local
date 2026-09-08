import { createHash } from 'node:crypto';

import type { Config } from './schema.js';

/**
 * A fingerprint of the whole configuration, with secret values left out.
 *
 * The whole of it on purpose. A digest over a hand-picked subset says two runs agree while a
 * setting nobody thought to list moved under them, and the list is exactly what goes stale.
 * Secrets are replaced by whether one is set, so rotating a key does not read as a
 * configuration change and setting one for the first time does.
 */

/** Config leaves that hold a secret. Their values never reach a digest, a report, or a log. */
export const SECRET_CONFIG_PATHS: readonly string[] = ['neo4j.password', 'anthropic.apiKey'];

export function redactedConfig(config: Config): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [group, leaves] of Object.entries(config)) {
    for (const [leaf, value] of Object.entries(leaves as Record<string, unknown>)) {
      const path = `${group}.${leaf}`;
      flat[path] = SECRET_CONFIG_PATHS.includes(path)
        ? `set:${String(typeof value === 'string' && value.length > 0)}`
        : value;
    }
  }
  return flat;
}

export function configDigest(config: Config): string {
  const flat = redactedConfig(config);
  const ordered = Object.keys(flat)
    .sort()
    .map((key) => [key, flat[key]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

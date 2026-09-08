import { createHash } from 'node:crypto';

import type { Config } from '../../../infrastructure/config/schema.js';

/**
 * The record a comparison is made against: what was read, from where, under which build and
 * configuration, and exactly which members were frozen.
 *
 * Written once and never recomputed. A later run that counts the same population is a second
 * observation, not a correction of this one, and the only way to tell a real change from a
 * changed denominator is to have the membership itself written down.
 */

/** Config leaves that hold a secret. Their values never reach a digest, a report, or a log. */
const SECRET_PATHS: readonly string[] = ['neo4j.password', 'anthropic.apiKey'];

export type SubstrateIdentity = {
  readonly graphEndpoint: string;
  readonly sqlitePath: string;
  /**
   * Whether the SQLite figures came from the running file or from a copy taken beside it.
   * A copy taken while the service is running is an observational capture: the two stores
   * were not stopped, so their readings are bounded by the window rather than atomic.
   */
  readonly sqliteSource: 'live_file' | 'copy_of_live';
};

export type FrozenMembership = {
  readonly staleEdgeIds: readonly string[];
  readonly graphSourceIds: readonly string[];
  readonly narrativeIds: readonly string[];
};

export type CampaignManifest = {
  /** A digest over the frozen membership and the window it was read in. */
  readonly manifestId: string;
  readonly metricVersion: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly buildSha: string;
  readonly configDigest: string;
  readonly substrate: SubstrateIdentity;
  readonly frozen: FrozenMembership;
  /**
   * What the readings describe. Until compatible writers are live on both stores, a paged read
   * of a substrate still taking writes is bounded by its window and is not a snapshot.
   */
  readonly observationKind: 'bounded_window';
};

/** Every leaf, with a secret's value replaced by the fact that one is set. */
function redacted(config: Config): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [group, leaves] of Object.entries(config)) {
    for (const [leaf, value] of Object.entries(leaves as Record<string, unknown>)) {
      const path = `${group}.${leaf}`;
      flat[path] = SECRET_PATHS.includes(path)
        ? `set:${String(typeof value === 'string' && value.length > 0)}`
        : value;
    }
  }
  return flat;
}

export function configDigest(config: Config): string {
  const flat = redacted(config);
  const ordered = Object.keys(flat)
    .sort()
    .map((key) => [key, flat[key]]);
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export type ManifestInput = {
  readonly metricVersion: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly buildSha: string;
  readonly config: Config;
  readonly substrate: SubstrateIdentity;
  readonly frozen: FrozenMembership;
};

export function buildCampaignManifest(input: ManifestInput): CampaignManifest {
  const membership = createHash('sha256')
    .update(
      JSON.stringify([
        input.startedAt,
        input.finishedAt,
        [...input.frozen.staleEdgeIds].sort(),
        [...input.frozen.graphSourceIds].sort(),
        [...input.frozen.narrativeIds].sort(),
      ]),
    )
    .digest('hex');

  return {
    manifestId: membership,
    metricVersion: input.metricVersion,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    buildSha: input.buildSha,
    configDigest: configDigest(input.config),
    substrate: input.substrate,
    frozen: input.frozen,
    observationKind: 'bounded_window',
  };
}

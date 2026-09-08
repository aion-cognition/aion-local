import { createHash } from 'node:crypto';

import { configDigest } from '../../../infrastructure/config/digest.js';
import type { Config } from '../../../infrastructure/config/schema.js';

/**
 * The record a comparison is made against: what was read, from where, under which build and
 * configuration, and exactly which members were frozen.
 *
 * Written once and never recomputed. A later run that counts the same population is a second
 * observation, not a correction of this one, and the only way to tell a real change from a
 * changed denominator is to have the membership itself written down.
 */

/**
 * How the SQLite figures were acquired.
 *
 * `backup_api` is the supported consistent read: SQLite copies the database through a reader
 * that holds its own transaction, so the result is one state rather than a mixture. A plain
 * file copy taken while writers are active is not that, and it keeps its own name so a reading
 * derived from one is never read as the other.
 */
export type SqliteAcquisition = 'live_file' | 'copy_of_live' | 'backup_api';

export type SubstrateIdentity = {
  readonly graphEndpoint: string;
  readonly sqlitePath: string;
  readonly sqliteSource: SqliteAcquisition;
  /** When the copy was taken, which is a different window from the graph read. */
  readonly sqliteAcquiredFrom?: string;
  readonly sqliteAcquiredUntil?: string;
  /** sha256 of the file the readings were taken from. */
  readonly sqliteDigest?: string;
};

/**
 * What produced the readings and what the substrate had installed. The collector's build is
 * knowable here; the running service's is not, and it says so rather than borrowing the
 * collector's.
 */
export type BuildProvenance = {
  readonly collectorBuildSha: string;
  readonly deployedBuildSha: string;
  readonly collectorArchiveSchemaVersion: number;
  readonly installedSqliteTables: readonly string[];
  readonly appliedGraphMigrations: readonly string[];
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
  readonly provenance: BuildProvenance;
  readonly configDigest: string;
  readonly substrate: SubstrateIdentity;
  readonly frozen: FrozenMembership;
  /**
   * What the readings describe. Until compatible writers are live on both stores, a paged read
   * of a substrate still taking writes is bounded by its window and is not a snapshot.
   */
  readonly observationKind: 'bounded_window';
};

export type ManifestInput = {
  readonly metricVersion: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly buildSha: string;
  readonly provenance: BuildProvenance;
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
    provenance: input.provenance,
    configDigest: configDigest(input.config),
    substrate: input.substrate,
    frozen: input.frozen,
    observationKind: 'bounded_window',
  };
}

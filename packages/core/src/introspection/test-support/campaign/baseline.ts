import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveLimitReports } from './limits.js';
import {
  reading,
  walkArchive,
  walkGraphSources,
  walkNarrativeEdges,
  walkNarratives,
  type WalkOutcome,
} from './walks.js';
import {
  readEntityMentionDistribution,
  readRelationshipTypeCounts,
  type MentionBucket,
  type RelationshipTypeCount,
} from '../../../infrastructure/graph/campaign-cohort-queries.js';
import {
  countOrphanNodes,
  DEFAULT_HEALTH_SCAN_LIMIT,
} from '../../../infrastructure/graph/introspection-health.js';
import {
  countGraphElements,
  countNodesByLabel,
} from '../../../infrastructure/graph/introspection.js';
import {
  readApiCallCensus,
  readArchiveCensus,
  readUsageEventCensus,
  type ApiCallCensus,
  type ArchiveCensus,
  type ArchiveRecordShape,
  type UsageEventCensus,
} from '../../../infrastructure/sqlite/campaign-archive-reads.js';
import { sqliteTableExists, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  distributionOf,
  type Distribution,
  type LimitReport,
} from '../../domain/campaign-distribution.js';
import {
  unavailableGroup,
  withUncollected,
  type GaugeGroup,
} from '../../domain/campaign-gauge-groups.js';
import {
  measuredGauge,
  unavailableGauge,
  type Gauge,
  type GaugeBasis,
  type GaugeStamp,
} from '../../domain/campaign-gauges.js';

/**
 * The read-only baseline: what the substrate holds now, taken through the gauge envelope so
 * every number carries the population it was counted over.
 *
 * Nothing here throws. A store that refuses one read still leaves every other reading standing,
 * and the refusal comes back as an unavailable gauge with its reason, because a collector that
 * dies on the first outage reports nothing at all and a report of nothing is indistinguishable
 * from a substrate holding nothing.
 */

export const METRIC_VERSION = 1;

/** Ceiling on the entity and orphan scans, reported beside the readings it bounds. */
const MENTION_SCAN_LIMIT = DEFAULT_HEALTH_SCAN_LIMIT;

export type CampaignBaseline = {
  readonly stamp: GaugeStamp;
  readonly gauges: Readonly<Record<GaugeGroup, Record<string, Gauge>>>;
  readonly labelPopulations?: Readonly<Record<string, number>>;
  readonly relationshipTypes?: readonly RelationshipTypeCount[];
  readonly mentionBuckets?: readonly MentionBucket[];
  /** Absent when its walk failed. Empty membership is a reading, not a substitute for one. */
  readonly staleEdgeIds?: readonly string[];
  readonly narrativeIds?: readonly string[];
  readonly graphSourceIds?: readonly string[];
  readonly archive?: ArchiveCensus;
  readonly usageEvents?: UsageEventCensus;
  readonly apiCalls?: ApiCallCensus;
  readonly limitReports: Readonly<Record<string, LimitReport>>;
  /** Populations measured with no proposed bound to check them against yet. */
  readonly distributions: Readonly<Record<string, Distribution>>;
  /** Named observations no producer exists for yet, so a reader is not left guessing. */
  readonly notInstalled: readonly GaugeGroup[];
  /** Every walk or reading that did not answer, with the reason it did not. */
  readonly failures: Readonly<Record<string, string>>;
  /** True only when every cohort walk persisted every member it examined. */
  readonly exportComplete: boolean;
};

export type BaselineDeps = {
  readonly driver: Driver;
  /** Absent when no substrate file was reachable, which every SQLite group then reports. */
  readonly db?: SqliteHandle;
  readonly sampledAt: string;
  /** Where the cohort pages are persisted. A temporary directory when the caller names none. */
  readonly exportDir?: string;
};

/** The groups whose producing schema does not ship yet, reported whole rather than skipped. */
const PENDING_GROUPS: readonly GaugeGroup[] = [
  'seal_demand',
  'eviction_demand',
  'recovery',
  'evidence_integrity',
  'work_preservation',
];

type Collected = {
  readonly outcomes: Map<string, Gauge>;
  readonly failures: Map<string, string>;
};

function note<T>(collected: Collected, name: string, outcome: WalkOutcome<T>): void {
  if (outcome.status === 'failed') {
    collected.failures.set(name, `${outcome.reason}: ${outcome.detail}`);
  }
}

export async function collectBaseline(deps: BaselineDeps): Promise<CampaignBaseline> {
  const live: GaugeBasis = { population: 'live', denominator: 'the whole substrate' };
  const stamp: GaugeStamp = {
    sampledAt: deps.sampledAt,
    basis: live,
    metricVersion: METRIC_VERSION,
  };
  const owned = deps.exportDir === undefined;
  const dir = deps.exportDir ?? mkdtempSync(join(tmpdir(), 'aion-campaign-export-'));

  try {
    return await collect(deps, stamp, dir);
  } finally {
    if (owned) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function collect(
  deps: BaselineDeps,
  stamp: GaugeStamp,
  dir: string,
): Promise<CampaignBaseline> {
  const collected: Collected = { outcomes: new Map(), failures: new Map() };
  const scanned = (what: string): GaugeBasis => ({
    population: 'live',
    denominator: `${what}, first ${String(MENTION_SCAN_LIMIT)} scanned`,
  });

  const edges = await walkNarrativeEdges(deps.driver, dir);
  const sources = await walkGraphSources(deps.driver, dir);
  const narratives = await walkNarratives(deps.driver, dir);
  const labels = await reading(async () => countNodesByLabel(deps.driver));
  const elements = await reading(async () => countGraphElements(deps.driver));
  const orphans = await reading(async () => countOrphanNodes(deps.driver, MENTION_SCAN_LIMIT));
  const types = await reading(async () => readRelationshipTypeCounts(deps.driver));
  const buckets = await reading(async () =>
    readEntityMentionDistribution(deps.driver, MENTION_SCAN_LIMIT),
  );
  const archive = walkArchive(deps.db);

  note(collected, 'narrative_edges', edges);
  note(collected, 'graph_sources', sources);
  note(collected, 'narratives', narratives);
  note(collected, 'label_populations', labels);
  note(collected, 'graph_elements', elements);
  note(collected, 'orphan_count', orphans);
  note(collected, 'relationship_types', types);
  note(collected, 'entity_mentions', buckets);
  note(collected, 'experience_archive', archive);

  const staleEdgeIds =
    edges.status === 'ok'
      ? edges.rows.filter((edge) => edge.open && edge.targetClosed).map((edge) => edge.id)
      : undefined;
  const labelMap = labels.status === 'ok' ? labels.rows[0] : undefined;
  const elementCounts = elements.status === 'ok' ? elements.rows[0] : undefined;
  const orphanCounts = orphans.status === 'ok' ? orphans.rows[0] : undefined;
  const shapes: readonly ArchiveRecordShape[] = archive.status === 'ok' ? archive.rows : [];

  const { outcomes } = collected;
  outcomes.set(
    'stale_edge_partition',
    staleEdgeIds === undefined
      ? unavailableGauge('collector_failed', stamp)
      : measuredGauge(staleEdgeIds.length, 'edges', stamp),
  );
  outcomes.set(
    'label_populations',
    labelMap === undefined
      ? unavailableGauge('collector_failed', stamp)
      : measuredGauge(labelMap.size, 'labels', stamp),
  );
  outcomes.set(
    'physical_node_count',
    elementCounts === undefined
      ? unavailableGauge('collector_failed', stamp)
      : measuredGauge(elementCounts.nodes, 'nodes', stamp),
  );
  outcomes.set(
    'physical_relationship_count',
    elementCounts === undefined
      ? unavailableGauge('collector_failed', stamp)
      : measuredGauge(elementCounts.relationships, 'relationships', stamp),
  );
  outcomes.set(
    'orphan_count',
    orphanCounts === undefined
      ? unavailableGauge('collector_failed', stamp)
      : measuredGauge(orphanCounts.orphans, 'nodes', {
          ...stamp,
          basis: scanned('current Memory nodes past enrichment'),
        }),
  );
  outcomes.set(
    'entity_mention_distribution',
    buckets.status === 'ok' && buckets.rows[0] !== undefined
      ? measuredGauge(buckets.rows[0].length, 'buckets', {
          ...stamp,
          basis: scanned('current entities'),
        })
      : unavailableGauge('collector_failed', stamp),
  );
  outcomes.set(
    'inspectable_original_sources',
    sources.status === 'ok'
      ? measuredGauge(sources.rows.length, 'episodes', {
          ...stamp,
          basis: { population: 'live', denominator: 'Episode nodes, whatever their currency' },
        })
      : unavailableGauge('collector_failed', stamp),
  );
  // Physical byte figures need the server's own store reading and a disk measurement, and
  // neither is taken here. A cost figure needs a bounded surface measurement, which is a
  // later obligation: the call census below counts calls and says so in its own name.
  for (const name of [
    'physical_removal_bytes',
    'vector_bytes',
    'recall_trace_latency_ms',
    'unmeasured_pagecache_disk',
    'retained_node_state',
    'cost_by_surface',
  ]) {
    outcomes.set(name, unavailableGauge('not_collected', stamp));
  }
  outcomes.set('api_call_census', apiCallGauge(deps.db, stamp));
  if (deps.db === undefined) {
    outcomes.set('cost_by_surface', unavailableGauge('store_unavailable', stamp));
  } else if (!sqliteTableExists(deps.db, 'api_calls')) {
    outcomes.set('cost_by_surface', unavailableGauge('not_installed', stamp));
  }

  const sourceRows = sources.status === 'ok' ? sources.rows : [];
  const textLengths = distributionOf(sourceRows.map((source) => source.textLength));
  const turnCounts = distributionOf(sourceRows.map((source) => source.turnCount));
  const census =
    deps.db !== undefined && archive.status === 'ok'
      ? {
          archive: readArchiveCensus(deps.db),
          usageEvents: readUsageEventCensus(deps.db),
          apiCalls: readApiCallCensus(deps.db),
        }
      : {};

  return {
    stamp,
    gauges: {
      seal_demand: Object.fromEntries(unavailableGroup('seal_demand', 'not_installed', stamp)),
      eviction_demand: Object.fromEntries(
        unavailableGroup('eviction_demand', 'not_installed', stamp),
      ),
      recovery: Object.fromEntries(unavailableGroup('recovery', 'not_installed', stamp)),
      evidence_integrity: Object.fromEntries(
        unavailableGroup('evidence_integrity', 'not_installed', stamp),
      ),
      work_preservation: Object.fromEntries(
        unavailableGroup('work_preservation', 'not_installed', stamp),
      ),
      independent_outcomes: Object.fromEntries(
        withUncollected('independent_outcomes', outcomes, stamp),
      ),
    },
    ...(labelMap === undefined
      ? {}
      : { labelPopulations: Object.fromEntries([...labelMap.entries()].sort()) }),
    ...(types.status === 'ok' && types.rows[0] !== undefined
      ? { relationshipTypes: types.rows[0] }
      : {}),
    ...(buckets.status === 'ok' && buckets.rows[0] !== undefined
      ? { mentionBuckets: buckets.rows[0] }
      : {}),
    ...(staleEdgeIds === undefined ? {} : { staleEdgeIds }),
    ...(narratives.status === 'ok'
      ? { narrativeIds: narratives.rows.map((narrative) => narrative.id) }
      : {}),
    ...(sources.status === 'ok' ? { graphSourceIds: sourceRows.map((source) => source.id) } : {}),
    ...census,
    limitReports: archive.status === 'ok' ? archiveLimitReports(shapes) : {},
    distributions: {
      ...(textLengths === undefined ? {} : { episode_text_characters: textLengths }),
      ...(turnCounts === undefined ? {} : { episode_turn_count: turnCounts }),
    },
    notInstalled: PENDING_GROUPS,
    failures: Object.fromEntries(collected.failures),
    exportComplete: [edges, sources, narratives].every(
      (walk) => walk.status === 'ok' && walk.exportComplete,
    ),
  };
}

/** The call meter counted as calls, under its own name. It is not a cost. */
function apiCallGauge(db: SqliteHandle | undefined, stamp: GaugeStamp): Gauge {
  if (db === undefined) {
    return unavailableGauge('store_unavailable', stamp);
  }
  if (!sqliteTableExists(db, 'api_calls')) {
    return unavailableGauge('not_installed', stamp);
  }
  try {
    return measuredGauge(readApiCallCensus(db).rows, 'api calls', stamp);
  } catch {
    return unavailableGauge('collector_failed', stamp);
  }
}

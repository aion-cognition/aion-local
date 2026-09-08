import type { Driver } from 'neo4j-driver';

import {
  readEntityMentionDistribution,
  readGraphSourcePage,
  readNarrativeEdgeStatePage,
  readRelationshipTypeCounts,
  type MentionBucket,
  type NarrativeEdgeState,
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
  readArchiveShapePage,
  readUsageEventCensus,
  type ApiCallCensus,
  type ArchiveCensus,
  type ArchiveRecordShape,
  type UsageEventCensus,
} from '../../../infrastructure/sqlite/campaign-archive-reads.js';
import { sqliteTableExists, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  checkLimit,
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
import { COHORT_PAGE_BOUNDS } from '../../domain/campaign-paging.js';

/**
 * The read-only baseline: what the substrate holds now, taken through the gauge envelope so
 * every number carries the population it was counted over.
 *
 * Groups whose producing schema does not exist yet report their whole observation set as
 * unavailable rather than as zero. A backlog of nothing and a table that was never installed
 * look identical at the number, and only one of them means there is no work to do.
 */

export const METRIC_VERSION = 1;

/** Both walks page at the cohort bound, so an interrupted run resumes on the same key. */
const PAGE_ROWS = COHORT_PAGE_BOUNDS.maxRows;

/** Ceiling on the entity scan, reported beside the distribution it bounds. */
const MENTION_SCAN_LIMIT = DEFAULT_HEALTH_SCAN_LIMIT;

export type CampaignBaseline = {
  readonly stamp: GaugeStamp;
  readonly gauges: Readonly<Record<GaugeGroup, Record<string, Gauge>>>;
  readonly labelPopulations: Readonly<Record<string, number>>;
  readonly relationshipTypes: readonly RelationshipTypeCount[];
  readonly mentionBuckets: readonly MentionBucket[];
  readonly staleEdgeIds: readonly string[];
  readonly narrativeIds: readonly string[];
  readonly graphSourceIds: readonly string[];
  readonly archive?: ArchiveCensus;
  readonly usageEvents?: UsageEventCensus;
  readonly apiCalls?: ApiCallCensus;
  readonly limitReports: Readonly<Record<string, LimitReport>>;
  /** Populations measured with no proposed bound to check them against yet. */
  readonly distributions: Readonly<Record<string, Distribution>>;
  /** Named observations no producer exists for yet, so a reader is not left guessing. */
  readonly notInstalled: readonly GaugeGroup[];
};

function stampFor(sampledAt: string, basis: GaugeBasis): GaugeStamp {
  return { sampledAt, basis, metricVersion: METRIC_VERSION };
}

async function walkNarrativeEdges(driver: Driver): Promise<readonly NarrativeEdgeState[]> {
  const all: NarrativeEdgeState[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readNarrativeEdgeStatePage(driver, PAGE_ROWS, cursor);
    if (page.length === 0) {
      return all;
    }
    all.push(...page);
    cursor = page[page.length - 1]?.id;
  }
}

async function walkGraphSources(
  driver: Driver,
): Promise<
  readonly { readonly id: string; readonly textLength: number; readonly turnCount: number }[]
> {
  const all: { id: string; textLength: number; turnCount: number }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readGraphSourcePage(driver, PAGE_ROWS, cursor);
    if (page.length === 0) {
      return all;
    }
    all.push(
      ...page.map((row) => ({ id: row.id, textLength: row.textLength, turnCount: row.turnCount })),
    );
    cursor = page[page.length - 1]?.id;
  }
}

function walkArchive(db: SqliteHandle): readonly ArchiveRecordShape[] {
  const all: ArchiveRecordShape[] = [];
  let cursor: { occurredAt: string; id: string } | undefined;
  for (;;) {
    const page = readArchiveShapePage(db, cursor, PAGE_ROWS);
    if (page.length === 0) {
      return all;
    }
    all.push(...page);
    const last = page[page.length - 1];
    cursor = last === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id };
  }
}

/**
 * The proposed bounds the stored corpus is checked against. Only the ones whose subject is
 * already stored are here: a limit on a record shape nothing writes yet has no corpus to be
 * measured against, and reporting it as passing would be reporting an absence as a result.
 */
const REQUEST_LIMITS = {
  turns: 200,
  observations: 64,
  toolExecutions: 64,
  payloadBytes: 512 * 1024,
  rawPayloadBytes: 256 * 1024,
} as const;

function archiveLimitReports(
  shapes: readonly ArchiveRecordShape[],
): Readonly<Record<string, LimitReport>> {
  const keyed = (pick: (shape: ArchiveRecordShape) => number) =>
    shapes.map((shape) => ({ key: shape.episodeId, value: pick(shape) }));
  return {
    request_turns: checkLimit(
      keyed((shape) => shape.turnCount),
      REQUEST_LIMITS.turns,
      'turns',
    ),
    request_observations: checkLimit(
      keyed((shape) => shape.observationCount),
      REQUEST_LIMITS.observations,
      'observations',
    ),
    request_tool_executions: checkLimit(
      keyed((shape) => shape.toolExecutionCount),
      REQUEST_LIMITS.toolExecutions,
      'tool executions',
    ),
    request_payload_bytes: checkLimit(
      keyed((shape) => shape.payloadBytes),
      REQUEST_LIMITS.payloadBytes,
      'bytes',
    ),
    raw_source_bytes: checkLimit(
      keyed((shape) => shape.payloadBytes),
      REQUEST_LIMITS.rawPayloadBytes,
      'bytes',
    ),
  };
}

export type BaselineDeps = {
  readonly driver: Driver;
  /** Absent when no substrate file was reachable, which every SQLite group then reports. */
  readonly db?: SqliteHandle;
  readonly sampledAt: string;
};

/** The groups whose producing schema does not ship yet, reported whole rather than skipped. */
const PENDING_GROUPS: readonly GaugeGroup[] = [
  'seal_demand',
  'eviction_demand',
  'recovery',
  'evidence_integrity',
  'work_preservation',
];

export async function collectBaseline(deps: BaselineDeps): Promise<CampaignBaseline> {
  const live: GaugeBasis = { population: 'live', denominator: 'the whole substrate' };
  const stamp = stampFor(deps.sampledAt, live);

  const edges = await walkNarrativeEdges(deps.driver);
  const sources = await walkGraphSources(deps.driver);
  const labels = await countNodesByLabel(deps.driver);
  const elements = await countGraphElements(deps.driver);
  const orphans = await countOrphanNodes(deps.driver, MENTION_SCAN_LIMIT);
  const relationshipTypes = await readRelationshipTypeCounts(deps.driver);
  const mentionBuckets = await readEntityMentionDistribution(deps.driver, MENTION_SCAN_LIMIT);

  const staleEdgeIds = edges
    .filter((edge) => edge.open && edge.targetClosed)
    .map((edge) => edge.id);
  const narrativeIds = [...new Set(edges.map((edge) => edge.targetId))].sort();

  const substrate = deps.db;
  const archiveInstalled =
    substrate !== undefined && sqliteTableExists(substrate, 'experience_archive');
  const shapes = substrate !== undefined && archiveInstalled ? walkArchive(substrate) : [];

  const outcomes = new Map<string, Gauge>([
    ['stale_edge_partition', measuredGauge(staleEdgeIds.length, 'edges', stamp)],
    ['label_populations', measuredGauge(labels.size, 'labels', stamp)],
    ['physical_node_count', measuredGauge(elements.nodes, 'nodes', stamp)],
    ['physical_relationship_count', measuredGauge(elements.relationships, 'relationships', stamp)],
    [
      'orphan_count',
      measuredGauge(orphans.orphans, 'nodes', {
        ...stamp,
        basis: {
          population: 'live',
          denominator: `current Memory nodes past enrichment, first ${String(MENTION_SCAN_LIMIT)} scanned`,
        },
      }),
    ],
    [
      'entity_mention_distribution',
      measuredGauge(mentionBuckets.length, 'buckets', {
        ...stamp,
        basis: {
          population: 'live',
          denominator: `current entities, first ${String(MENTION_SCAN_LIMIT)} scanned`,
        },
      }),
    ],
    [
      'inspectable_original_sources',
      measuredGauge(sources.length, 'episodes', {
        ...stamp,
        basis: { population: 'live', denominator: 'Episode nodes, whatever their currency' },
      }),
    ],
    // Physical byte figures need the server's own store reading and a disk measurement, and
    // neither is taken here. Reported as not collected rather than left out.
    ['physical_removal_bytes', unavailableGauge('not_collected', stamp)],
    ['vector_bytes', unavailableGauge('not_collected', stamp)],
    ['recall_trace_latency_ms', unavailableGauge('not_collected', stamp)],
    ['unmeasured_pagecache_disk', unavailableGauge('not_collected', stamp)],
    ['retained_node_state', unavailableGauge('not_collected', stamp)],
  ]);

  if (deps.db === undefined) {
    outcomes.set('cost_by_surface', unavailableGauge('store_unavailable', stamp));
  } else {
    const calls = readApiCallCensus(deps.db);
    outcomes.set('cost_by_surface', measuredGauge(calls.rows, 'api calls', stamp));
  }

  const gauges = {
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
  };

  const sourceTextLengths = distributionOf(sources.map((source) => source.textLength));
  const turnCounts = distributionOf(sources.map((source) => source.turnCount));

  return {
    stamp,
    gauges,
    labelPopulations: Object.fromEntries([...labels.entries()].sort()),
    relationshipTypes,
    mentionBuckets,
    staleEdgeIds,
    narrativeIds,
    graphSourceIds: sources.map((source) => source.id),
    ...(deps.db === undefined || !archiveInstalled
      ? {}
      : {
          archive: readArchiveCensus(deps.db),
          usageEvents: readUsageEventCensus(deps.db),
          apiCalls: readApiCallCensus(deps.db),
        }),
    limitReports: archiveLimitReports(shapes),
    distributions: {
      ...(sourceTextLengths === undefined ? {} : { episode_text_characters: sourceTextLengths }),
      ...(turnCounts === undefined ? {} : { episode_turn_count: turnCounts }),
    },
    notInstalled: PENDING_GROUPS,
  };
}

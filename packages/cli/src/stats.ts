import {
  ConfigError,
  countGraphElements,
  countNodesByLabel,
  cueDegradedRate,
  EDGE_WEIGHT_DISTRIBUTION_TYPES,
  edgeWeightDistribution,
  GraphConnection,
  introspectionCycle,
  introspectionOperations,
  latestLedgerEntry,
  listLastPackSessions,
  listOperationStats,
  loadConfig,
  OPERATION_LEDGER_PREFIX,
  openLogger,
  PACK_METHODS,
  packMethodCounters,
  plasticityCounters,
  queueLagSnapshot,
  recallCadenceCounters,
  SqliteStore,
  type Config,
  type EdgeWeightDistribution,
  type GraphCounts,
  type OperationStats,
  type PackMethodCounters,
  type PlasticityCounters,
  type QueueLagSnapshot,
  type RecallCadenceCounters,
  type SqliteHandle,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/**
 * `aion stats`: everything `aion status` shows plus the two readings PRD §3.4 pins as
 * measured product signals. Cadence answers whether the agent is actually calling recall;
 * the per-method shares are the spirit metric, permanent so the associative-mechanisms
 * claim stays a measurement, not an argument.
 */

/**
 * One maintenance operation's record: the counters the engine keeps, plus what its most
 * recent bucket claim wrote to the ops ledger. The two come from different places on purpose.
 * The counters answer how the operation has been doing over its life; the ledger entry is the
 * evidence that one particular window ran and what it did in it.
 */
export type MaintenanceOperationReading = {
  readonly stats: OperationStats;
  readonly lastStatus?: string;
  readonly lastItemsAffected?: number;
  readonly lastDetail?: string;
};

export type MaintenanceSnapshot = {
  /** Ticks the loop has taken. Starvation is measured in these, not in wall time. */
  readonly cycle: number;
  readonly operations: readonly MaintenanceOperationReading[];
};

export type StatsSnapshot = {
  readonly neo4jReachable: boolean;
  /** Label to node count; a node with several labels appears under each. */
  readonly labelCounts: ReadonlyMap<string, number>;
  readonly graph?: GraphCounts;
  readonly queue: QueueLagSnapshot;
  readonly plasticity: PlasticityCounters;
  readonly edgeWeights?: EdgeWeightDistribution;
  readonly cadence: RecallCadenceCounters;
  /** Distinct sessions a pack has ever been served to, for the calls-per-session reading. */
  readonly sessionsServed: number;
  readonly degradedRate?: number;
  readonly methodCounters: PackMethodCounters;
  readonly maintenance: MaintenanceSnapshot;
};

/** The engine writes this object as the ledger summary; a hand-edited row may not match it. */
type LedgerSummary = {
  readonly status?: unknown;
  readonly itemsAffected?: unknown;
  readonly detail?: unknown;
};

function readLedgerSummary(summary: unknown): LedgerSummary {
  if (typeof summary !== 'object' || summary === null) {
    return {};
  }
  return summary as LedgerSummary;
}

/**
 * Reads the catalog rather than a stored list of names, so an operation registered in
 * `introspectionOperations` shows up here with no second place to remember to add it. One that
 * has never run reports zeroes, which is the honest reading and not an omission.
 */
export function collectMaintenance(db: SqliteHandle): MaintenanceSnapshot {
  const names = introspectionOperations().map((operation) => operation.name);
  const operations = listOperationStats(db, names).map((stats) => {
    const entry = latestLedgerEntry(db, `${OPERATION_LEDGER_PREFIX}${stats.name}:`);
    const summary = readLedgerSummary(entry?.summary);
    return {
      stats,
      ...(typeof summary.status === 'string' ? { lastStatus: summary.status } : {}),
      ...(typeof summary.itemsAffected === 'number'
        ? { lastItemsAffected: summary.itemsAffected }
        : {}),
      ...(typeof summary.detail === 'string' ? { lastDetail: summary.detail } : {}),
    };
  });
  return { cycle: introspectionCycle(db), operations };
}

export async function collectStats(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
): Promise<StatsSnapshot> {
  const health = await connection.health();
  const labelCounts = health.reachable ? await countNodesByLabel(connection.driver) : new Map<string, number>();
  const graph = health.reachable ? await countGraphElements(connection.driver) : undefined;
  const edgeWeights = health.reachable ? await edgeWeightDistribution(connection.driver) : undefined;
  const degradedRate = cueDegradedRate(db);

  return {
    neo4jReachable: health.reachable,
    labelCounts,
    ...(graph === undefined ? {} : { graph }),
    queue: queueLagSnapshot(db, config.operational.workerMaxAttempts),
    plasticity: plasticityCounters(db),
    ...(edgeWeights === undefined ? {} : { edgeWeights }),
    cadence: recallCadenceCounters(db),
    sessionsServed: listLastPackSessions(db).length,
    ...(degradedRate === undefined ? {} : { degradedRate }),
    methodCounters: packMethodCounters(db),
    maintenance: collectMaintenance(db),
  };
}

/** `12s` / `4m` / `1h`, matching `aion status`'s own age formatting. */
function ageOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) {
    return `${String(seconds)}s`;
  }
  if (seconds < 7200) {
    return `${String(Math.round(seconds / 60))}m`;
  }
  return `${String(Math.round(seconds / 3600))}h`;
}

function formatEdgeWeights(distribution: EdgeWeightDistribution): string {
  return EDGE_WEIGHT_DISTRIBUTION_TYPES.map((type) => {
    const stats = distribution[type];
    if (stats === undefined) {
      return `${type} n=0`;
    }
    return `${type} p50=${stats.p50.toFixed(2)} (n=${String(stats.count)})`;
  }).join(', ');
}

function totalMethodCount(counters: PackMethodCounters): number {
  return PACK_METHODS.reduce((sum, method) => sum + counters[method], 0);
}

const OPERATION_NAME_WIDTH = 24;

/**
 * One line per registered operation. An operation with no runs says so rather than printing a
 * row of zeroes that reads like a measurement, since "never selected" and "selected and did
 * nothing" are different answers to the only question this section exists for.
 */
function renderMaintenance(snapshot: MaintenanceSnapshot, now: number, write: Writer): void {
  write('');
  write('maintenance');
  write(
    `  cycle ${String(snapshot.cycle)}, ${String(snapshot.operations.length)} operations registered`,
  );
  for (const reading of snapshot.operations) {
    const { stats } = reading;
    const name = stats.name.padEnd(OPERATION_NAME_WIDTH);
    if (stats.lastRunAt === undefined) {
      write(`  ${name} never selected`);
      continue;
    }
    const age = ageOf(Math.max(0, now - Date.parse(stats.lastRunAt)));
    const affected =
      reading.lastItemsAffected === undefined
        ? ''
        : ` (${String(reading.lastItemsAffected)} affected)`;
    write(
      `  ${name} runs ${String(stats.runs)}  improved ${String(stats.improved)}  ` +
        `unchanged ${String(stats.unchanged)}  failed ${String(stats.failed)}  ` +
        `last ${age} ago ${reading.lastStatus ?? 'unrecorded'}${affected}`,
    );
  }
}

export function renderStats(snapshot: StatsSnapshot, write: Writer, now: number = Date.now()): void {
  write('substrate');
  if (!snapshot.neo4jReachable) {
    write('  counts unavailable while Neo4j is down');
  } else if (snapshot.labelCounts.size === 0) {
    write('  empty');
  } else {
    for (const [label, count] of snapshot.labelCounts) {
      write(`  ${label.padEnd(14)} ${String(count)}`);
    }
  }
  if (snapshot.graph !== undefined) {
    write(`  total: ${String(snapshot.graph.nodes)} nodes, ${String(snapshot.graph.relationships)} relationships`);
  }

  write('');
  write('queue');
  const { queue } = snapshot;
  const oldest = queue.oldestUnclaimedMs === undefined ? 'none unclaimed' : ageOf(queue.oldestUnclaimedMs);
  const p95 = queue.p95EnrichmentLagMs === undefined ? 'no samples yet' : ageOf(queue.p95EnrichmentLagMs);
  write(
    `  interactive=${String(queue.depthByLane.interactive)} bulk=${String(queue.depthByLane.bulk)}, ` +
      `oldest unclaimed ${oldest}, ${String(queue.exhausted)} exhausted`,
  );
  write(`  lag  p95 intake-to-enriched ${p95}`);

  write('');
  write('plasticity');
  const { plasticity } = snapshot;
  write(
    `  reinforce  ${String(plasticity.reinforcement.signalsApplied)} signals / ` +
      `${String(plasticity.reinforcement.pairsApplied)} pairs / ${String(plasticity.reinforcement.edgesUpdated)} edges, ` +
      `queue depth ${String(plasticity.reinforcementQueueDepth)}`,
  );
  write(
    `  decay      ${String(plasticity.decay.edgesScanned)} scanned / ${String(plasticity.decay.edgesDecayed)} decayed`,
  );
  write(
    snapshot.edgeWeights === undefined
      ? '  weights    unavailable while Neo4j is down'
      : `  weights    ${formatEdgeWeights(snapshot.edgeWeights)}`,
  );

  write('');
  write('cadence');
  const { cadence } = snapshot;
  const perSession = snapshot.sessionsServed === 0 ? undefined : cadence.totalCalls / snapshot.sessionsServed;
  write(
    `  calls        ${String(cadence.totalCalls)} across ${String(snapshot.sessionsServed)} sessions` +
      (perSession === undefined ? '' : ` (${perSession.toFixed(1)} per session)`),
  );
  const emptyRate = cadence.totalCalls === 0 ? undefined : cadence.emptyPacks / cadence.totalCalls;
  write(
    `  empty packs  ${String(cadence.emptyPacks)}` +
      (emptyRate === undefined ? '' : ` (${(emptyRate * 100).toFixed(1)}%)`),
  );
  write(
    `  degraded     ${snapshot.degradedRate === undefined ? 'no recalls measured yet' : `${(snapshot.degradedRate * 100).toFixed(1)}%`}`,
  );

  write('');
  write('pack contribution by method (the spirit metric)');
  const total = totalMethodCount(snapshot.methodCounters);
  for (const method of PACK_METHODS) {
    const count = snapshot.methodCounters[method];
    const share = total === 0 ? 0 : (count / total) * 100;
    write(`  ${method.padEnd(18)} ${String(count).padStart(6)}  ${share.toFixed(1)}%`);
  }

  renderMaintenance(snapshot.maintenance, now, write);
}

export async function runStats(
  _argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-stats' });
  const connection = new GraphConnection(config.neo4j);
  const store = new SqliteStore({ filePath: config.sqlite.path });
  try {
    const snapshot = await collectStats(config, connection, store.db);
    renderStats(snapshot, write);
    logger.info({ ...snapshot, labelCounts: Object.fromEntries(snapshot.labelCounts) }, 'stats reported');
    return snapshot.neo4jReachable ? 0 : 1;
  } finally {
    await connection.close();
    store.close();
  }
}

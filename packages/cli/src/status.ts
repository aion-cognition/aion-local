import {
  ConfigError,
  countGraphElements,
  EDGE_WEIGHT_DISTRIBUTION_TYPES,
  edgeWeightDistribution,
  GraphConnection,
  listOllamaModels,
  listResidentModels,
  loadConfig,
  openLogger,
  plasticityCounters,
  queueLagSnapshot,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
  SqliteStore,
  unbackedPins,
  type Config,
  type EdgeWeightDistribution,
  type PlasticityCounters,
  type QueueLagSnapshot,
  type SqliteHandle,
} from '@aion/core';

import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

export type StatusSnapshot = {
  readonly neo4j: { readonly uri: string; readonly reachable: boolean; readonly detail: string };
  readonly ollama: {
    readonly url: string;
    readonly reachable: boolean;
    readonly models: readonly string[];
    readonly detail?: string;
  };
  /**
   * Models Ollama is holding in memory right now, which is the number that matters on a
   * laptop: `models` above is what is on disk. Absent when Ollama did not answer.
   */
  readonly resident?: readonly string[];
  readonly graph?: { readonly nodes: number; readonly relationships: number };
  /** SQLite-only, so this is present whether or not Neo4j answered. */
  readonly queue: QueueLagSnapshot;
  /** SQLite-only, same reasoning as `queue`. */
  readonly plasticity: PlasticityCounters;
  /** The one bounded graph read, present only when Neo4j answered, like `graph` above. */
  readonly edgeWeights?: EdgeWeightDistribution;
};

export async function collectStatus(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
): Promise<StatusSnapshot> {
  const health = await connection.health();
  const graph = health.reachable ? await countGraphElements(connection.driver) : undefined;
  const edgeWeights = health.reachable
    ? await edgeWeightDistribution(connection.driver)
    : undefined;

  let models: readonly string[] = [];
  let resident: readonly string[] | undefined;
  let ollamaError: string | undefined;
  try {
    models = await listOllamaModels(config.ollama.url);
    resident = (await listResidentModels(config.ollama.url)).map((model) => model.name);
  } catch (err) {
    ollamaError = describeError(err);
  }

  return {
    neo4j: {
      uri: connection.uri,
      reachable: health.reachable,
      detail: health.reachable ? (health.agent ?? 'neo4j') : (health.error ?? 'unreachable'),
    },
    ollama: {
      url: config.ollama.url,
      reachable: ollamaError === undefined,
      models,
      ...(ollamaError === undefined ? {} : { detail: ollamaError }),
    },
    ...(resident === undefined ? {} : { resident }),
    ...(graph === undefined ? {} : { graph }),
    queue: queueLagSnapshot(db, config.operational.workerMaxAttempts),
    plasticity: plasticityCounters(db),
    ...(edgeWeights === undefined ? {} : { edgeWeights }),
  };
}

/** `12s` / `4m` / `1h`, matching `aion queue`'s own age formatting. */
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

/** One clause per type, in the fixed order the distribution reports them; a type with no live edge reads as `n=0`. */
function formatEdgeWeights(distribution: EdgeWeightDistribution): string {
  return EDGE_WEIGHT_DISTRIBUTION_TYPES.map((type) => {
    const stats = distribution[type];
    if (stats === undefined) {
      return `${type} n=0`;
    }
    return `${type} p50=${stats.p50.toFixed(2)} (min=${stats.min.toFixed(2)} max=${stats.max.toFixed(2)}, n=${String(stats.count)})`;
  }).join(', ');
}

export function renderStatus(snapshot: StatusSnapshot, config: Config, write: Writer): void {
  write(
    `neo4j    ${snapshot.neo4j.reachable ? 'up' : 'down'}  ${snapshot.neo4j.uri} — ${snapshot.neo4j.detail}`,
  );
  write(
    `ollama   ${snapshot.ollama.reachable ? 'up' : 'down'}  ${snapshot.ollama.url}${snapshot.ollama.detail === undefined ? '' : ` — ${snapshot.ollama.detail}`}`,
  );

  write('');
  const routing = resolveProviderRouting(config);
  write(
    `models   embed=${config.models.embed} cue=${config.models.cue} reflect=${config.models.reflect}`,
  );
  write(`routing  ${routingSummary(routing)} (embeddings always ${config.models.embed}, local)`);
  for (const route of unbackedPins(routing)) {
    write(
      `         ${route.role} is pinned to anthropic with no key set, so it runs on ${route.localModel}`,
    );
  }
  if (snapshot.ollama.models.length > 0) {
    write(`installed  ${snapshot.ollama.models.join(', ')}`);
  }
  if (snapshot.resident !== undefined) {
    write(
      `resident   ${snapshot.resident.length === 0 ? 'nothing loaded in memory' : snapshot.resident.join(', ')}`,
    );
  }
  for (const line of remoteBannerLines(routing)) {
    write(line);
  }

  write('');
  if (snapshot.graph === undefined) {
    write('graph    counts unavailable while Neo4j is down');
  } else {
    write(`graph    ${snapshot.graph.nodes} nodes, ${snapshot.graph.relationships} relationships`);
  }

  write('');
  const { queue } = snapshot;
  const oldest =
    queue.oldestUnclaimedMs === undefined ? 'none unclaimed' : ageOf(queue.oldestUnclaimedMs);
  const p95 =
    queue.p95EnrichmentLagMs === undefined ? 'no samples yet' : ageOf(queue.p95EnrichmentLagMs);
  const depth = `interactive=${String(queue.depthByLane.interactive)} bulk=${String(queue.depthByLane.bulk)}`;
  const degraded =
    queue.cueDegradedRate === undefined
      ? 'no recalls yet'
      : `${(queue.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`;
  write(`queue    ${depth}, oldest unclaimed ${oldest}, ${String(queue.exhausted)} exhausted`);
  write(
    `lag      p95 intake-to-enriched ${p95}, ${String(queue.reinforcementDropped)} reinforcement rows dropped`,
  );
  write(`recall   ${degraded}`);
  write(
    `review   ${String(queue.supersessionProposalsOpen)} supersession, ` +
      `${String(queue.entityMergeProposalsOpen)} entity-merge proposals open — aion proposals ls`,
  );

  write('');
  const { plasticity } = snapshot;
  write(
    `hebbian  reinforce ${String(plasticity.reinforcement.signalsApplied)} signals / ` +
      `${String(plasticity.reinforcement.pairsApplied)} pairs / ${String(plasticity.reinforcement.edgesUpdated)} edges ` +
      `(last run ${plasticity.reinforcement.lastRunAt ?? 'never run'}), queue depth ${String(plasticity.reinforcementQueueDepth)}`,
  );
  write(
    `decay    ${String(plasticity.decay.edgesScanned)} scanned / ${String(plasticity.decay.edgesDecayed)} decayed ` +
      `(last run ${plasticity.decay.lastRunAt ?? 'never run'})`,
  );
  if (snapshot.edgeWeights === undefined) {
    write('weights  unavailable while Neo4j is down');
  } else {
    write(`weights  ${formatEdgeWeights(snapshot.edgeWeights)}`);
  }
}

export async function runStatus(
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

  const logger = openLogger({ ...config.logging, name: 'aion-status' });
  const connection = new GraphConnection(config.neo4j);
  const store = new SqliteStore({ filePath: config.sqlite.path });
  try {
    const snapshot = await collectStatus(config, connection, store.db);
    renderStatus(snapshot, config, write);
    logger.info({ snapshot }, 'status reported');
    return snapshot.neo4j.reachable && snapshot.ollama.reachable ? 0 : 1;
  } finally {
    await connection.close();
    store.close();
  }
}

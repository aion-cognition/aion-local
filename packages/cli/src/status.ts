import {
  ConfigError,
  countGraphElements,
  GraphConnection,
  listOllamaModels,
  loadConfig,
  openLogger,
  queueLagSnapshot,
  SqliteStore,
  type Config,
  type QueueLagSnapshot,
  type SqliteHandle,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

export type StatusSnapshot = {
  readonly neo4j: { readonly uri: string; readonly reachable: boolean; readonly detail: string };
  readonly ollama: { readonly url: string; readonly reachable: boolean; readonly models: readonly string[]; readonly detail?: string };
  readonly graph?: { readonly nodes: number; readonly relationships: number };
  /** SQLite-only, so this is present whether or not Neo4j answered. */
  readonly queue: QueueLagSnapshot;
};

export async function collectStatus(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
): Promise<StatusSnapshot> {
  const health = await connection.health();
  const graph = health.reachable ? await countGraphElements(connection.driver) : undefined;

  let models: readonly string[] = [];
  let ollamaError: string | undefined;
  try {
    models = await listOllamaModels(config.ollama.url);
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
    ...(graph === undefined ? {} : { graph }),
    queue: queueLagSnapshot(db, config.operational.workerMaxAttempts),
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

export function renderStatus(snapshot: StatusSnapshot, config: Config, write: Writer): void {
  write(`neo4j    ${snapshot.neo4j.reachable ? 'up' : 'down'}  ${snapshot.neo4j.uri} — ${snapshot.neo4j.detail}`);
  write(`ollama   ${snapshot.ollama.reachable ? 'up' : 'down'}  ${snapshot.ollama.url}${snapshot.ollama.detail === undefined ? '' : ` — ${snapshot.ollama.detail}`}`);

  write('');
  write(`models   embed=${config.models.embed} cue=${config.models.cue} reflect=${config.models.reflect}`);
  if (snapshot.ollama.models.length > 0) {
    write(`installed  ${snapshot.ollama.models.join(', ')}`);
  }

  write('');
  if (snapshot.graph === undefined) {
    write('graph    counts unavailable while Neo4j is down');
  } else {
    write(`graph    ${snapshot.graph.nodes} nodes, ${snapshot.graph.relationships} relationships`);
  }

  write('');
  const { queue } = snapshot;
  const oldest = queue.oldestUnclaimedMs === undefined ? 'none unclaimed' : ageOf(queue.oldestUnclaimedMs);
  const p95 = queue.p95EnrichmentLagMs === undefined ? 'no samples yet' : ageOf(queue.p95EnrichmentLagMs);
  const depth = `interactive=${String(queue.depthByLane.interactive)} bulk=${String(queue.depthByLane.bulk)}`;
  const degraded =
    queue.cueDegradedRate === undefined
      ? 'no recalls yet'
      : `${(queue.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`;
  write(`queue    ${depth}, oldest unclaimed ${oldest}, ${String(queue.exhausted)} exhausted`);
  write(`lag      p95 intake-to-enriched ${p95}, ${String(queue.reinforcementDropped)} reinforcement rows dropped`);
  write(`recall   ${degraded}`);
  write(
    `review   ${String(queue.supersessionProposalsOpen)} supersession, ` +
      `${String(queue.entityMergeProposalsOpen)} entity-merge proposals open — aion proposals ls`,
  );
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

import {
  ConfigError,
  countGraphElements,
  GraphConnection,
  listOllamaModels,
  loadConfig,
  openLogger,
  type Config,
} from '@aion/core';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

export type StatusSnapshot = {
  readonly neo4j: { readonly uri: string; readonly reachable: boolean; readonly detail: string };
  readonly ollama: { readonly url: string; readonly reachable: boolean; readonly models: readonly string[]; readonly detail?: string };
  readonly graph?: { readonly nodes: number; readonly relationships: number };
};

export async function collectStatus(config: Config, connection: GraphConnection): Promise<StatusSnapshot> {
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
  };
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
    return;
  }
  write(`graph    ${snapshot.graph.nodes} nodes, ${snapshot.graph.relationships} relationships`);
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
  try {
    const snapshot = await collectStatus(config, connection);
    renderStatus(snapshot, config, write);
    logger.info({ snapshot }, 'status reported');
    return snapshot.neo4j.reachable && snapshot.ollama.reachable ? 0 : 1;
  } finally {
    await connection.close();
  }
}

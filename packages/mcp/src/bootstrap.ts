import { userInfo } from 'node:os';
import {
  bootstrapBackbone,
  CueCache,
  GraphConnection,
  handleRecall,
  handleReflection,
  latestAppliedGraphMigration,
  loadConfig,
  openLogger,
  OllamaProvider,
  readMemberName,
  RecallSideEffects,
  ReflectionDispatch,
  SessionManager,
  SqliteStore,
  type Config,
  type Logger,
  type RecallDeps,
  type ReflectionIntakeDeps,
} from '@aion/core';
import { bindHost, runningInContainer } from './http.js';
import { AionMcpService } from './service.js';
import type { ToolBackend } from './tools.js';

/**
 * PRD §4: the service owns one driver, one SQLite handle, one session cache, and one cue
 * cache for its whole life, and hands them to every tool call. Construction order is the
 * dependency order — config, log, storage, graph, backbone, provider — so a failure names
 * the first thing that was actually wrong rather than a symptom two layers down.
 */

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

export class GraphUnreachableError extends Error {
  constructor(uri: string, detail: string) {
    super(`Neo4j at ${uri} is unreachable: ${detail}`);
    this.name = 'GraphUnreachableError';
  }
}

export class SchemaNotInitializedError extends Error {
  constructor(path: string) {
    super(`no graph migration recorded in ${path}; run \`aion init\` before starting the service`);
    this.name = 'SchemaNotInitializedError';
  }
}

export type AionService = {
  readonly service: AionMcpService;
  readonly config: Config;
  readonly logger: Logger;
  close(): Promise<void>;
};

/**
 * Only used when the substrate has no Member yet, which the schema check above makes nearly
 * unreachable: an initialized substrate always has one, and its stored name wins.
 */
function fallbackMemberName(env: NodeJS.ProcessEnv): string {
  const fromEnv = (env[GIT_USER_NAME_ENV_VAR] ?? '').trim();
  if (fromEnv !== '') {
    return fromEnv;
  }
  try {
    return userInfo().username;
  } catch {
    return 'aion';
  }
}

export async function bootstrapService(env: NodeJS.ProcessEnv): Promise<AionService> {
  const config = loadConfig(env);
  const logger = openLogger({ ...config.logging, name: 'aion-mcp' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection(config.neo4j);

  try {
    const health = await connection.health();
    if (!health.reachable) {
      throw new GraphUnreachableError(connection.uri, health.error ?? 'unknown error');
    }
    if (latestAppliedGraphMigration(store.db) === undefined) {
      throw new SchemaNotInitializedError(config.sqlite.path);
    }

    const driver = connection.driver;
    const memberName = (await readMemberName(driver)) ?? fallbackMemberName(env);
    const backbone = await bootstrapBackbone(driver, { memberName });
    const sessions = new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    });

    const provider = new OllamaProvider({
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
    });
    const dispatch = new ReflectionDispatch({
      onListenerError: (err, signal) => {
        logger.error({ err, jobId: signal.jobId }, 'reflection dispatch listener failed');
      },
    });
    const sideEffects = new RecallSideEffects(driver, store.db, logger);

    const recall: RecallDeps = {
      driver,
      db: store.db,
      sessions,
      provider,
      config,
      cueCache: new CueCache(),
      logger,
      onRecalled: sideEffects.onRecalled,
    };
    const intake: ReflectionIntakeDeps = {
      driver,
      db: store.db,
      sessions,
      provider,
      dispatch,
      logger,
      entropyThreshold: config.redaction.entropyThreshold,
    };

    const backend: ToolBackend = {
      recall: (args, identity) => handleRecall(recall, args, { identity }),
      reflection: (args, identity) => handleReflection(intake, args, { identity }),
    };

    const service = new AionMcpService({
      backend,
      logger,
      host: bindHost(runningInContainer()),
      port: config.operational.mcpPort,
    });

    logger.info(
      {
        neo4j: connection.uri,
        ollama: config.ollama.url,
        sqlite: config.sqlite.path,
        member: memberName,
        models: config.models,
      },
      'mcp service ready',
    );

    return {
      service,
      config,
      logger,
      close: async () => {
        await service.close();
        await connection.close();
        store.close();
      },
    };
  } catch (err) {
    await connection.close();
    store.close();
    logger.fatal({ err }, 'mcp service failed to start');
    throw err;
  }
}

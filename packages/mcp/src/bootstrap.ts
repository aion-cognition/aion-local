import { userInfo } from 'node:os';
import {
  AssociationInferenceStage,
  bootstrapBackbone,
  CognitiveExtractionStage,
  ContextVectorStage,
  CueCache,
  EntityDedupStage,
  EntityExtractionStage,
  GraphConnection,
  handleRecall,
  handleReflection,
  IdleNarrativeSweeper,
  LaneAssigner,
  latestAppliedGraphMigration,
  loadConfig,
  openLogger,
  OllamaProvider,
  queueLagSnapshot,
  readMemberName,
  RecallSideEffects,
  ReflectionDispatch,
  ReflectionOrchestrator,
  ReflectionWorker,
  ReinforcementEnqueueStage,
  SemanticRelationshipStage,
  SessionManager,
  SessionNarrativeCloser,
  SessionNarrativeStage,
  SqliteStore,
  SupersessionStage,
  type Config,
  type Logger,
  type RecallDeps,
  type ReflectionIntakeDeps,
  type ReflectionStage,
  type ReflectionWorkerOptions,
  type SessionNarrativeOptions,
} from '@aion/core';
import { bindHost, runningInContainer } from './http.js';
import { AionMcpService } from './service.js';
import { SessionIdleSweeper } from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/**
 * PRD §4: the service owns one driver, one SQLite handle, one session cache, and one cue
 * cache for its whole life, and hands them to every tool call. Construction order is the
 * dependency order — config, log, storage, graph, backbone, provider — so a failure names
 * the first thing that was actually wrong rather than a symptom two layers down.
 */

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

const MINUTE_MS = 60 * 1000;

/**
 * The pipeline, in the one place its order lives, and the order is whitepaper Algorithm 4's.
 * Identity is resolved before anything reads it — extraction, then deduplication — because a
 * later stage that pairs, links, or judges duplicate entities writes the duplication into the
 * graph as structure (§6.5). Supersession follows cognitive extraction, since the facts it
 * judges are the Decision and Insight nodes that stage writes. Context vectors run last:
 * they aggregate over whatever the rest of the run just changed.
 *
 * Algorithm 4's step 9, narrative evaluation, is last. It carries the idle rule rather than
 * the close: a session whose episodes are reflecting seconds after they arrived is still
 * open, and the stage skips it, leaving the narrative to `SessionNarrativeCloser`. What it
 * catches is the other case — a backlog drained hours late, a retry that landed after the
 * client was gone — where no close hook will ever fire again.
 *
 * An empty list would leave the worker down: an orchestrator with nothing to run enriches
 * nothing, which reads to the worker as a failed job and spends the episode's retries on it.
 */
export function reflectionStages(config: Config): readonly ReflectionStage[] {
  const model = config.models.reflect;
  const reflection = config.reflection;
  return [
    new EntityExtractionStage({
      model,
      timeoutMs: reflection.entityTimeoutMs,
      maxEntities: reflection.maxEntities,
    }),
    new EntityDedupStage({ similarityThreshold: reflection.entityDedupThreshold }),
    new AssociationInferenceStage({
      semanticThreshold: reflection.associationSemanticThreshold,
      similarLimit: reflection.associationSimilarLimit,
    }),
    new CognitiveExtractionStage({
      model,
      timeoutMs: reflection.cognitiveTimeoutMs,
      maxNodes: reflection.maxCognitiveNodes,
    }),
    new SemanticRelationshipStage({
      model,
      timeoutMs: reflection.semanticTimeoutMs,
      maxRelationships: reflection.maxRelationships,
    }),
    new SupersessionStage({
      model,
      timeoutMs: reflection.supersedeTimeoutMs,
      mode: reflection.supersedeMode,
      autoConfidence: reflection.supersedeAutoConfidence,
      neighborThreshold: reflection.supersedeNeighborThreshold,
      maxSubjects: reflection.maxSupersessionSubjects,
      maxNeighbors: reflection.maxContradictionNeighbors,
      maxJudgments: reflection.maxContradictionJudgments,
    }),
    new ReinforcementEnqueueStage({ reinforcementQueueCap: config.sqlite.reinforcementQueueCap }),
    new ContextVectorStage(),
    new SessionNarrativeStage(narrativeOptions(config)),
  ];
}

export function narrativeOptions(config: Config): SessionNarrativeOptions {
  return {
    model: config.models.reflect,
    idleMs: config.reflection.narrativeIdleMinutes * MINUTE_MS,
    timeoutMs: config.reflection.narrativeTimeoutMs,
    maxSourceEpisodes: config.reflection.maxNarrativeEpisodes,
    maxEpisodeChars: config.reflection.maxNarrativeEpisodeChars,
  };
}

export function workerOptions(config: Config): ReflectionWorkerOptions {
  return {
    workerCount: config.operational.workerCount,
    staleTimeoutMs: config.operational.workerStaleClaimTimeoutMs,
    retryBaseMs: config.operational.workerRetryBaseMs,
    retryCapMs: config.operational.workerRetryCapMs,
    maxAttempts: config.operational.workerMaxAttempts,
    breakerThreshold: config.operational.workerBreakerThreshold,
    breakerCooldownMs: config.operational.workerBreakerCooldownMs,
    vectorBatchSize: config.operational.workerVectorBatchSize,
  };
}

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
    const sideEffects = new RecallSideEffects(
      driver,
      store.db,
      logger,
      config.sqlite.reinforcementQueueCap,
    );

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
      // One assigner for the service's life: its counters are the arrival rate, and a fresh
      // instance per call would measure nothing.
      lanes: new LaneAssigner(config.lanes),
    };

    const stages = reflectionStages(config);
    const worker = new ReflectionWorker(
      {
        driver,
        db: store.db,
        provider,
        dispatch,
        runner: new ReflectionOrchestrator({ driver, db: store.db, provider, logger }, stages),
        logger,
      },
      workerOptions(config),
    );
    if (stages.length > 0) {
      // The drain runs alongside the first tool calls rather than in front of them: a long
      // backlog would otherwise hold the service off the port it is supposed to be answering.
      void worker.start().catch((err: unknown) => {
        logger.error({ err }, 'reflection worker drain failed');
      });
    } else {
      logger.warn('reflection worker idle: no pipeline stages are registered');
    }

    // Whitepaper §6.10's session boundary, both halves of the pinned trigger. The transport
    // close is the boundary the substrate can observe; the sweep is what a client that
    // disconnects without a DELETE — an editor that exits — leaves behind.
    const narrativeDeps = { driver, provider, logger };
    const narratives = new SessionNarrativeCloser(narrativeDeps, narrativeOptions(config));
    const idleNarratives = new IdleNarrativeSweeper(narrativeDeps, {
      ...narrativeOptions(config),
      limit: config.reflection.narrativeSweepLimit,
    });
    idleNarratives.start();

    const backend: ToolBackend = {
      recall: (args, identity) => handleRecall(recall, args, { identity }),
      reflection: (args, identity) => handleReflection(intake, args, { identity }),
    };

    const service = new AionMcpService({
      backend,
      logger,
      host: bindHost(runningInContainer()),
      port: config.operational.mcpPort,
      onSessionClosed: narratives.onSessionClosed,
      queueLag: () => queueLagSnapshot(store.db, config.operational.workerMaxAttempts),
    });

    // EX-32's backstop: a client's close() never sends the DELETE `onSessionClosed` above
    // depends on, so a session with no request in this long closes on its own instead.
    const idleSessions = new SessionIdleSweeper(service, {
      idleMs: config.operational.sessionIdleExpiryMinutes * MINUTE_MS,
    });
    idleSessions.start();

    logger.info(
      {
        neo4j: connection.uri,
        ollama: config.ollama.url,
        sqlite: config.sqlite.path,
        member: memberName,
        models: config.models,
        stages: stages.map((stage) => stage.name),
        narrativeSweepMs: idleNarratives.intervalMs,
        sessionIdleSweepMs: idleSessions.intervalMs,
      },
      'mcp service ready',
    );

    return {
      service,
      config,
      logger,
      close: async () => {
        // Stop the idle sweep before the service closes its own transports, so shutdown
        // cannot race a sweep tick into closing a session the drain is already tearing down.
        idleSessions.stop();
        // The service first, so every transport closes and its narrative is scheduled before
        // the closer is awaited; the driver goes last, since both are still writing to it.
        await service.close();
        await narratives.whenIdle();
        await idleNarratives.stop();
        await worker.stop();
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

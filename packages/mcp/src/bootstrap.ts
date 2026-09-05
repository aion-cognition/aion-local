import {
  acceptsHookCapture,
  bootstrapBackbone,
  CueCache,
  deleteServedItems,
  GraphConnection,
  handleRecall,
  handleReflection,
  IdleNarrativeSweeper,
  Introspector,
  introspectionOperations,
  LaneAssigner,
  latestAppliedGraphMigration,
  loadConfig,
  modelAdvisor,
  narrativeOptions,
  narrativeSweepOptions,
  openLogger,
  plasticityCounters,
  ProviderRouter,
  purgeServedItemsIdleSince,
  queueLagSnapshot,
  readMemberName,
  RecallSideEffects,
  reconcileResidentModels,
  recordLifecycleEvent,
  ReflectionOrchestrator,
  reflectionStages,
  ReflectionWorker,
  routingSummary,
  SessionManager,
  SessionNarrativeCloser,
  SqliteStore,
  unbackedPins,
  workerOptions,
  type Config,
  type Logger,
  type Provider,
  type RecallDeps,
  type ReconciliationReport,
  type ReflectionIntakeDeps,
} from '@aion/core';
import { userInfo } from 'node:os';

import { bindHost, runningInContainer } from './http.js';
import { AionMcpService } from './service.js';
import { SessionIdleSweeper } from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/**
 * The service owns one driver, one SQLite handle, one session cache, and one cue cache for
 * its whole life, and hands them to every tool call. Construction order is the dependency
 * order (config, log, storage, graph, backbone, provider), so a failure names the first
 * thing that was actually wrong rather than a symptom two layers down.
 */

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

const MINUTE_MS = 60 * 1000;

/**
 * The pipeline and its option builders live in `@aion/core`, beside the stage contract, so the
 * introspection loop can build the same stages this service does without depending on the MCP
 * package. They are re-exported here because the CLI's replay and timeline verbs and the gate
 * fixtures reach the pipeline through the service that runs it.
 */
export { narrativeOptions, narrativeSweepOptions, reflectionStages, workerOptions };

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
 * Boot's half of model reconciliation: a local model no role still routes to leaves memory,
 * so a key-covered install does not hold instruct weights it will never call. `aion init` runs
 * the other half. Failures are logged and nothing else: the service does not depend on this,
 * and a machine with Ollama down has nothing resident to unload.
 */
async function reconcileModels(
  config: Config,
  router: ProviderRouter,
  logger: Logger,
): Promise<ReconciliationReport | undefined> {
  try {
    const report = await reconcileResidentModels({
      baseUrl: config.ollama.url,
      routing: router.routing,
    });
    if (report.checked) {
      logger.info({ reconciliation: report }, `model reconciliation: ${report.detail}`);
    }
    return report;
  } catch (err) {
    logger.warn({ err }, 'model reconciliation failed');
    return undefined;
  }
}

/**
 * One probe embed at boot, so a cold Ollama pays its model load here rather than inside the
 * first recall, whose callers sit in synchronous harness hooks with a 10s budget. The logged
 * duration is the cold/warm tell: seconds is a load, milliseconds is a model already resident.
 * Fail-open like reconciliation: the service never depends on the warm having happened.
 */
export async function warmEmbedModel(embedder: Provider, logger: Logger): Promise<void> {
  const started = Date.now();
  try {
    await embedder.embed(['embed warm-up probe']);
    logger.info({ ms: Date.now() - started }, 'embed model warmed');
  } catch (err) {
    logger.warn({ err, ms: Date.now() - started }, 'embed warm-up failed');
  }
}

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
  // The service takes the fd 1 tee, which is what `docker logs` reads. The CLI does not: its
  // answers go to fd 1.
  const logger = openLogger({ ...config.logging, name: 'aion-mcp', stdout: true });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection(config.neo4j);

  // Every component that starts on its own clock or its own event loop, in construction
  // order. A failure partway through construction has to stop whichever of these already
  // started before the driver and the store close, or it keeps running against a connection
  // nothing else is using any more.
  let sideEffects: RecallSideEffects | undefined;
  let worker: ReflectionWorker | undefined;
  let idleNarratives: IdleNarrativeSweeper | undefined;
  let introspector: Introspector | undefined;
  let service: AionMcpService | undefined;
  let idleSessions: SessionIdleSweeper | undefined;
  let narratives: SessionNarrativeCloser | undefined;

  /**
   * The same order `close` below uses, so a failure partway through startup tears down
   * whichever of these already started, and a normal shutdown tears down all of them.
   */
  const teardown = async (): Promise<void> => {
    idleSessions?.stop();
    if (introspector !== undefined) {
      await introspector.stop();
    }
    if (service !== undefined) {
      await service.close();
    }
    if (narratives !== undefined) {
      await narratives.whenIdle();
    }
    if (sideEffects !== undefined) {
      // The access-tracking write recall schedules is deferred and fire-and-forget by
      // contract, so a recall that landed just before shutdown can still have one in
      // flight; the driver closing under it would drop the write and swallow it into a warn.
      await sideEffects.whenIdle();
    }
    if (idleNarratives !== undefined) {
      await idleNarratives.stop();
    }
    if (worker !== undefined) {
      await worker.stop();
    }
    await connection.close();
    store.close();
  };

  try {
    const health = await connection.health();
    if (!health.reachable) {
      throw new GraphUnreachableError(connection.uri, health.error ?? 'unknown error');
    }
    if (latestAppliedGraphMigration(store.db) === undefined) {
      throw new SchemaNotInitializedError(config.sqlite.path);
    }

    const { driver } = connection;
    const memberName = (await readMemberName(driver)) ?? fallbackMemberName(env);
    const backbone = await bootstrapBackbone(driver, { memberName });
    const sessions = new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    });

    const router = new ProviderRouter({
      config,
      onGeneration: (event) => {
        logger.debug({ generation: event }, 'generation routed');
      },
    });
    // Both roles embed through the same local model; only `generate` differs between them.
    const cueProvider = router.forRole('cue');
    const reflectProvider = router.forRole('reflect');
    logger.info(
      { routing: router.routing.roles },
      `provider routing: ${routingSummary(router.routing)}`,
    );
    for (const route of unbackedPins(router.routing)) {
      logger.warn(
        { role: route.role },
        `${route.role} is pinned to anthropic with no AION_ANTHROPIC_API_KEY set; routing it to ${route.localModel} instead`,
      );
    }
    const reconciliation = await reconcileModels(config, router, logger);
    // Deliberately not awaited: binding the port never waits on Ollama, and an early recall
    // queues behind the same model load either way.
    void warmEmbedModel(router.embedder, logger);

    sideEffects = new RecallSideEffects(
      driver,
      store.db,
      logger,
      config.sqlite.reinforcementQueueCap,
    );

    const recall: RecallDeps = {
      driver,
      db: store.db,
      sessions,
      provider: cueProvider,
      config,
      cueCache: new CueCache(),
      logger,
      onRecalled: sideEffects.onRecalled,
    };
    const stages = reflectionStages(config);
    worker = new ReflectionWorker(
      {
        driver,
        db: store.db,
        provider: reflectProvider,
        runner: new ReflectionOrchestrator(
          { driver, db: store.db, provider: reflectProvider, logger },
          stages,
        ),
        logger,
      },
      workerOptions(config),
    );
    // Narrowed once so the closures below don't each have to prove `worker` is still the same
    // instance the outer, reassignable binding held when they were built.
    const reflectionWorker = worker;

    // Built after the worker because it wakes it: reflection is event-driven, and the queue
    // row is what survives a restart rather than what a loop watches.
    const intake: ReflectionIntakeDeps = {
      driver,
      db: store.db,
      sessions,
      // Intake only embeds, so the role it borrows changes nothing about where its calls go.
      provider: reflectProvider,
      onJobEnqueued: () => {
        reflectionWorker.wake();
      },
      logger,
      entropyThreshold: config.redaction.entropyThreshold,
      workerMaxAttempts: config.operational.workerMaxAttempts,
      // One assigner for the service's life: its counters are the arrival rate, and a fresh
      // instance per call would measure nothing.
      lanes: new LaneAssigner(config.lanes),
      acceptHookCapture: acceptsHookCapture(router.routing),
    };
    // A boot that unloaded a model changed what the substrate runs on, which is worth
    // remembering; a boot that found nothing resident changed nothing. Recorded through the
    // intake deps above, and not awaited for the reason the embed warm-up is not: binding the
    // port never waits on Ollama.
    if (reconciliation !== undefined && reconciliation.evicted.length > 0) {
      void recordLifecycleEvent(intake, {
        event: 'models_reconciled',
        text:
          `boot reconciled resident models: ${reconciliation.detail}. ` +
          `Routing is now ${routingSummary(router.routing)}`,
      });
    }

    if (stages.length > 0) {
      // The drain runs alongside the first tool calls rather than in front of them: a long
      // backlog would otherwise hold the service off the port it is supposed to be answering.
      void reflectionWorker.start().catch((err: unknown) => {
        logger.error({ err }, 'reflection worker drain failed');
      });
    } else {
      logger.warn('reflection worker idle: no pipeline stages are registered');
    }

    // Both halves of the pinned trigger. The transport close is the boundary the substrate
    // can observe; the sweep is what a client that disconnects without a DELETE (an editor
    // that exits) leaves behind.
    const narrativeDeps = { driver, provider: reflectProvider, logger };
    narratives = new SessionNarrativeCloser(narrativeDeps, narrativeOptions(config));
    idleNarratives = new IdleNarrativeSweeper(narrativeDeps, narrativeSweepOptions(config));
    idleNarratives.start();
    const sessionNarratives = narratives;

    // The introspection loop. The catalog is a plain ordered list rather than a lookup the
    // engine owns, so an operation joins maintenance by being registered in that one function
    // and nowhere else. The loop starts here and stops in `close` below, ahead of the driver,
    // because a tick that has begun can still hold a graph write.
    const maintenanceOperations = introspectionOperations();
    introspector = new Introspector(
      {
        driver,
        db: store.db,
        config,
        logger,
        // One provider for the whole loop, so its circuit breaker counts failures across runs
        // rather than starting fresh inside each one.
        provider: reflectProvider,
        // The same write path the tool call takes, for the operation that stores what it did as
        // an experience. It is the service's own instance rather than a second one, so a
        // question the loop files wakes the worker and counts toward the same arrival rate.
        intake,
        operations: maintenanceOperations,
      },
      {
        // The strategic tier's model call, wired here for the same reason every other provider
        // reaches its caller through construction: the loop never builds one of its own.
        tier3Advisor: modelAdvisor({ provider: reflectProvider, logger, config }),
      },
    );
    introspector.start();

    const backend: ToolBackend = {
      recall: (args, identity) => handleRecall(recall, args, { identity }),
      reflection: (args, identity) => handleReflection(intake, args, { identity }),
    };

    service = new AionMcpService({
      backend,
      logger,
      host: bindHost(runningInContainer()),
      port: config.operational.mcpPort,
      onSessionClosed: (sessionId) => {
        sessionNarratives.onSessionClosed(sessionId);
        sessions.forget(sessionId);
        // The served-item record describes one agent's live context, so it dies with the
        // session it describes. Both close paths land here, the client's DELETE and the idle
        // sweep, so the rows outlive a session by at most the idle window.
        deleteServedItems(store.db, sessionId);
      },
      queueLag: () => queueLagSnapshot(store.db, config.operational.workerMaxAttempts),
      plasticity: () => plasticityCounters(store.db),
    });

    // The primary trigger, not the fallback: a client's close() tears down its own
    // transport and never sends the DELETE `onSessionClosed` above
    // depends on, so a session with no request in this long closes on its own instead.
    idleSessions = new SessionIdleSweeper(service, {
      idleMs: config.operational.sessionIdleExpiryMinutes * MINUTE_MS,
      purgeIdleBefore: (cutoff) => {
        purgeServedItemsIdleSince(store.db, cutoff.toISOString());
      },
    });
    idleSessions.start();

    logger.info(
      {
        neo4j: connection.uri,
        ollama: config.ollama.url,
        sqlite: config.sqlite.path,
        member: memberName,
        models: config.models,
        routing: routingSummary(router.routing),
        stages: stages.map((stage) => stage.name),
        narrativeSweepMs: idleNarratives.intervalMs,
        sessionIdleSweepMs: idleSessions.intervalMs,
        maintenanceTickMs: introspector.tickMs,
        maintenanceOperations: maintenanceOperations.map((operation) => operation.name),
      },
      'mcp service ready',
    );

    return {
      service,
      config,
      logger,
      // Stop the idle sweep before the service closes its own transports, so shutdown cannot
      // race a sweep tick into closing a session the drain is already tearing down; maintenance
      // stops next, since a tick that started can still be holding a graph write and its own
      // abort signal is what lets an operation cut that short; the service closes third, so
      // every transport closes and its narrative and access-tracking writes are scheduled
      // before either is awaited; the driver and the store go last, since all of the above are
      // still writing to them.
      close: teardown,
    };
  } catch (err) {
    await teardown();
    logger.fatal({ err }, 'mcp service failed to start');
    throw err;
  }
}

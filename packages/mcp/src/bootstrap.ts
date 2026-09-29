import {
  activateCoverageOnStart,
  ApiUsageRecorder,
  bootstrapBackbone,
  checkedRecallDeps,
  configNotices,
  CueCache,
  deleteServedItems,
  GenerationSpendGuard,
  GraphConnection,
  handleReflectionResult,
  IdleNarrativeSweeper,
  Introspector,
  introspectionOperations,
  ReinforcementCadence,
  reinforcementDrain,
  LaneAssigner,
  appliedGraphSchemaVersion,
  loadConfig,
  modelAdvisor,
  narrativeOptions,
  narrativeSweepOptions,
  openLogger,
  plasticityCounters,
  prepareSubstrateRoots,
  probeRecall,
  publishBackboneBirth,
  publishPipelineReadinessPolicy,
  ProviderRouter,
  PublicationCoordinator,
  PublicationRecoveryLoop,
  INSTALLED_PUBLICATION_HANDLERS,
  CoveredJudgmentEvidence,
  EvidenceResolver,
  purgeServedItemsIdleSince,
  queueLagSnapshot,
  recallResultFor,
  readCoverageState,
  readMemberName,
  readSubstratePairing,
  RecallSideEffects,
  recordGenerationOutcome,
  ReflectionOrchestrator,
  reflectionStages,
  ReflectionWorker,
  runCheckedRecall,
  routingSummary,
  routingWarnings,
  SessionManager,
  SessionNarrativeCloser,
  SqliteStore,
  workerOptions,
  type Config,
  type Logger,
  type RecallDeps,
  type ReflectionIntakeDeps,
} from '@aion/core';
import { userInfo } from 'node:os';

import { archiveToolBackend } from './archive-tools.js';
import { reconcileModels, warmEmbedModel } from './boot-models.js';
import { bindHost, runningInContainer } from './http.js';
import { AionMcpService } from './service.js';
import { SessionIdleSweeper } from './session-idle-sweeper.js';
import type { ToolBackend } from './tools.js';

/** Constructs the service's shared dependencies in the order startup and teardown require. */

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

const MINUTE_MS = 60 * 1000;

/** Existing CLI and test consumers share the core pipeline builders through these exports. */
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
  // Ahead of the config, because the path defaults it carries are the container's and the logger
  // opens on the next line. A container run finds them already right and nothing is seeded.
  prepareSubstrateRoots(env);
  const config = loadConfig(env);
  // The service takes the fd 1 tee, which is what `docker logs` reads. The CLI does not: its
  // answers go to fd 1.
  const logger = openLogger({ ...config.logging, name: 'aion-mcp', stdout: true });
  for (const notice of configNotices(env)) {
    logger.warn(notice);
  }
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
  let reinforcement: ReinforcementCadence | undefined;
  let service: AionMcpService | undefined;
  let idleSessions: SessionIdleSweeper | undefined;
  let narratives: SessionNarrativeCloser | undefined;
  let publicationRecovery: PublicationRecoveryLoop | undefined;

  /**
   * The same order `close` below uses, so a failure partway through startup tears down
   * whichever of these already started, and a normal shutdown tears down all of them.
   */
  const teardown = async (): Promise<void> => {
    idleSessions?.stop();
    if (reinforcement !== undefined) {
      await reinforcement.stop();
    }
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
    await publicationRecovery?.stop();
    await connection.close();
    store.close();
  };

  try {
    const health = await connection.health();
    if (!health.reachable) {
      throw new GraphUnreachableError(connection.uri, health.error ?? 'unknown error');
    }
    if (appliedGraphSchemaVersion(store.db) === undefined) {
      throw new SchemaNotInitializedError(config.sqlite.path);
    }

    const { driver } = connection;
    const memberName = (await readMemberName(driver)) ?? fallbackMemberName(env);
    const backbone = await bootstrapBackbone(driver, { memberName });
    const publications = new PublicationCoordinator({
      driver,
      db: store.db,
      logger,
      // C7's acceptance operation joins the shared registry here: the coordinator owns the
      // guard and the receipts, and each cut owns the semantics of its own writes.
      handlers: [...INSTALLED_PUBLICATION_HANDLERS],
      observe: (publication) => {
        logger.info({ publication }, 'publication transaction');
      },
    });
    await publications.initialize();
    // Initialization opens the coverage contract preparing, and a preparing contract answers
    // every temporal read as partial for good. Ahead of the recovery loop so one actor is
    // asking for the guard at boot, and a no-op on every start after the first.
    const coverage = await activateCoverageOnStart(publications, store.db);
    logger.info({ coverage }, `coverage contract ${coverage.state}`);
    // Ahead of the worker, which reads the backbone as soon as an episode names it. The bootstrap
    // above cannot count what it mints because it runs before this coordinator exists.
    const backboneBirth = await publishBackboneBirth({ driver, db: store.db, publications });
    logger.info({ backboneBirth }, `backbone birth census ${backboneBirth.status}`);
    publicationRecovery = new PublicationRecoveryLoop(publications, logger, {
      retryBaseMs: config.operational.workerRetryBaseMs,
      retryCapMs: config.operational.workerRetryCapMs,
    });
    publicationRecovery.start();
    const sessions = new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    });

    // One guard for the process, over the substrate's own store: the reflect role, the cue role
    // and the batch pump all hold against the same day. It is the store rather than the instance
    // that shares it, so a second process and a restart read the same committed total.
    const spending = new GenerationSpendGuard({
      db: store.db,
      ceilingUsd: config.anthropic.dailyCeilingUsd,
    });
    const router = new ProviderRouter({
      config,
      spending,
      recordApiCall: new ApiUsageRecorder(store.db, logger).recordApiCall,
      onGeneration: (event) => {
        logger.debug({ generation: event }, 'generation routed');
        try {
          recordGenerationOutcome(store.db, event);
        } catch (err) {
          // Fail open, and for more than the usual reason. The router reports a success from
          // inside its own try, so a throw here would be caught there and counted as the
          // generation failing; the cue role runs this on the recall hot path.
          logger.warn({ err }, 'generation counter write failed');
        }
      },
    });
    // Both roles embed through the same local model; only `generate` differs between them.
    const cueProvider = router.forRole('cue');
    const reflectProvider = router.forRole('reflect');
    logger.info(
      { routing: router.routing.roles },
      `provider routing: ${routingSummary(router.routing)}`,
    );
    for (const warning of routingWarnings(router.routing)) {
      logger.warn(warning);
    }
    await reconcileModels(config, logger);
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
      cueCache: new CueCache({ ttlMinutes: config.recall.cueCacheTtlMinutes }),
      logger,
      onRecalled: sideEffects.onRecalled,
    };
    // One resolver for the process: the covered recall path and the worker's index drain read
    // the same stores through the same budgets.
    // The coordinator is the certification surface. A judgment assembled without one takes no
    // publication position at all, so a write it leads to lands on evidence nobody could certify.
    const resolver = new EvidenceResolver({ driver, db: store.db, logger, publications });
    // The seam a judging path asks before it spends a model call. It checks coverage per pair,
    // because a vantage pinned here would judge for the life of the process.
    const judgmentEvidence = new CoveredJudgmentEvidence({ db: store.db, resolver });
    const covered = checkedRecallDeps({ ...recall, coordinator: publications, resolver });
    const stages = reflectionStages(config);
    // Ahead of anything that can accept a source. A source accepted with no published policy
    // records a durable inventory obligation instead of the stages it owes, and clearing that
    // afterwards costs more than publishing the contract now. Republishing the same contract
    // takes no new revision, so a restart does not move what a source in flight is measured
    // against.
    const readinessPolicyRevision = publishPipelineReadinessPolicy(store.db, stages, new Date());
    worker = new ReflectionWorker(
      {
        driver,
        db: store.db,
        provider: reflectProvider,
        // A destructive stage judgment runs on certified evidence or abstains.
        runner: new ReflectionOrchestrator(
          {
            driver,
            db: store.db,
            provider: reflectProvider,
            logger,
            evidence: judgmentEvidence,
            publications,
          },
          stages,
        ),
        logger,
        // Where a finished run settles what it owed. There is no second way to complete a job.
        publications,
        // The process's one resolver, shared with the covered recall path.
        resolver,
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
      // The one path an accepted payload reaches either store by.
      publications,
      onJobEnqueued: () => {
        reflectionWorker.wake();
      },
      logger,
      entropyThreshold: config.redaction.entropyThreshold,
      workerMaxAttempts: config.operational.workerMaxAttempts,
      // One assigner for the service's life: its counters are the arrival rate, and a fresh
      // instance per call would measure nothing.
      lanes: new LaneAssigner(config.lanes),
    };
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
    const narrativeDeps = {
      driver,
      db: store.db,
      provider: reflectProvider,
      logger,
      publications,
      resolver,
    };
    narratives = new SessionNarrativeCloser(narrativeDeps, narrativeOptions(config));
    idleNarratives = new IdleNarrativeSweeper(narrativeDeps, narrativeSweepOptions(config));
    idleNarratives.start();
    const sessionNarratives = narratives;

    // Ordinary reinforcement, on its own bounded cadence rather than on the maintenance tick.
    // The drain is the one consumer: the maintenance operation below is handed this same owner,
    // so a manual `aion maintain` and this timer cannot read the same oldest bursts and apply
    // one window twice. It stops ahead of the introspector for the reason the introspector stops
    // ahead of the driver: a drain that has begun still holds a graph write.
    const drain = reinforcementDrain(
      { driver, db: store.db, logger },
      {
        batchSize: config.hebbian.batchSize,
        learningRate: config.hebbian.learningRate,
        weightFloor: config.hebbian.weightFloor,
        ceiling: config.hebbian.flushCeiling,
      },
    );
    reinforcement = new ReinforcementCadence(drain, {
      intervalMs: config.hebbian.drainIntervalMs,
      logger,
    });
    if (config.maintenance.reinforcementFlush) {
      reinforcement.start();
    }

    // The introspection loop. It stops in `close` below ahead of the driver, because a tick
    // that has begun can still hold a graph write. The catalog owns what may join it.
    const maintenanceOperations = introspectionOperations(config, drain);
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
        // The read path back out, for the operation that measures retrieval by using it. Built
        // from the same deps the tool call takes and stripped to a read that writes nothing;
        // `recall-probe.ts` states what it leaves out and why.
        recallProbe: probeRecall(recall),
        // One coordinator under four names: an uncertain apply reconciles against it, a
        // suppression and an owed confirmation signal are each settled under it, and the chunk
        // lifecycle seals and publishes through it beside the resolver recall already shares.
        publications,
        topology: publications,
        references: publications,
        narratives: { resolver, publications },
        // The same seam the pipeline judges through: one reading of the records, not two.
        evidence: judgmentEvidence,
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
      // The one covered recall entry point: coverage is decided before anything is spent, and
      // what a successful read writes commits at the publication boundary this coordinator owns.
      recall: async (args, identity) =>
        recallResultFor(await runCheckedRecall(covered, args, { identity })),
      reflection: (args, identity) => handleReflectionResult(intake, args, { identity }),
      ...archiveToolBackend({ driver, db: store.db, logger }),
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
      coverage: () => readCoverageState(store.db),
      // Through the handle the process is serving from, so the answer describes the file this
      // process actually holds rather than the file now sitting at the configured path.
      storeIdentity: () => readSubstratePairing(store.db)?.substrateId,
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
        readinessPolicyRevision,
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
      // Drain background writes before closing their driver and store.
      close: teardown,
    };
  } catch (err) {
    await teardown();
    logger.fatal({ err }, 'mcp service failed to start');
    throw err;
  }
}

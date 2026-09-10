import {
  ApiUsageRecorder,
  EvidenceResolver,
  INSTALLED_PUBLICATION_HANDLERS,
  LaneAssigner,
  ProviderRouter,
  PublicationCoordinator,
  SessionManager,
  type Config,
  type GraphConnection,
  type Logger,
  type ReflectionIntakeDeps,
  type SqliteHandle,
} from '@aion/core';

/**
 * What a command already holds by the time it has something to record: the substrate it just
 * wrote to, and the backbone that write resolved.
 */
export type LifecycleTarget = {
  readonly connection: GraphConnection;
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  readonly memberId: string;
  readonly workspaceId: string;
};

/**
 * Intake deps for a command that records one event and exits. A command runs no worker, so the
 * queue row it leaves is claimed by the service's next drain rather than by a wakeup from here.
 *
 * The lane assigner is fresh because its counters measure an arrival rate and a single push has
 * none. Nothing is lost: a lifecycle event asks for the bulk lane outright.
 *
 * The coordinator is built and initialized here for the same reason the service builds one: an
 * acceptance reaches either store only through a publication, and a command that recorded its
 * event any other way would be the one writer outside the protocol. Initialization runs after
 * the graph migrations the command already applied, since it checks the guard constraint one of
 * them declares and refuses to create it.
 */
export async function lifecycleIntakeDeps(target: LifecycleTarget): Promise<ReflectionIntakeDeps> {
  const { driver } = target.connection;
  const publications = new PublicationCoordinator({
    driver,
    db: target.db,
    logger: target.logger,
    // The whole installed set, not intake alone: a command meeting a pending operation of a
    // kind it did not install cannot recover it, and a single receipt means it must.
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await publications.initialize();
  return {
    publications,
    driver,
    db: target.db,
    sessions: new SessionManager(driver, {
      memberId: target.memberId,
      workspaceId: target.workspaceId,
    }),
    // Intake only embeds, so the role it borrows changes nothing about where its calls go.
    provider: new ProviderRouter({
      config: target.config,
      recordApiCall: new ApiUsageRecorder(target.db, target.logger).recordApiCall,
    }).forRole('reflect'),
    logger: target.logger,
    entropyThreshold: target.config.redaction.entropyThreshold,
    lanes: new LaneAssigner(target.config.lanes),
    workerMaxAttempts: target.config.operational.workerMaxAttempts,
    // The gate exists to keep a hook from flooding a local model with transcript. A command
    // recording one observation about itself is neither.
    acceptHookCapture: true,
  };
}

/**
 * What a command needs to reach the chunk lifecycle: the substrate it opened, and nothing about
 * a member or a workspace, because a maintenance run records no experience of its own.
 */
export type NarrativeTarget = Pick<LifecycleTarget, 'connection' | 'db' | 'logger'>;

/**
 * The resolver and coordinator a forced narrative run works through.
 *
 * A forced run is the second driver path, and it has to be the same path. `maintain run
 * narrative_seal` composed neither of these, so the operation found no publisher and declined
 * every time it was asked — the operation was listed, its `run` returned, and nothing about the
 * lifecycle was ever exercised from a command.
 *
 * One coordinator, initialized here for the reason the lifecycle intake initializes one: a
 * narrative reaches either store only through a publication, and a command that published any
 * other way would be the writer outside the protocol. The resolver is bound to the same store, so
 * what the run reads and what it publishes under are one substrate and one fence. The whole
 * installed handler set, so a command meeting a pending operation of a kind it did not install
 * can still recover it.
 */
export async function lifecycleNarrativeDeps(target: NarrativeTarget): Promise<{
  readonly resolver: EvidenceResolver;
  readonly publications: PublicationCoordinator;
}> {
  const { driver } = target.connection;
  const publications = new PublicationCoordinator({
    driver,
    db: target.db,
    logger: target.logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await publications.initialize();
  return {
    publications,
    resolver: new EvidenceResolver({
      driver,
      db: target.db,
      logger: target.logger,
      publications,
    }),
  };
}

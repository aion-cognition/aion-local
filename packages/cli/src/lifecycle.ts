import {
  LaneAssigner,
  ProviderRouter,
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
 */
export function lifecycleIntakeDeps(target: LifecycleTarget): ReflectionIntakeDeps {
  const { driver } = target.connection;
  return {
    driver,
    db: target.db,
    sessions: new SessionManager(driver, {
      memberId: target.memberId,
      workspaceId: target.workspaceId,
    }),
    // Intake only embeds, so the role it borrows changes nothing about where its calls go.
    provider: new ProviderRouter({ config: target.config }).forRole('reflect'),
    logger: target.logger,
    entropyThreshold: target.config.redaction.entropyThreshold,
    lanes: new LaneAssigner(target.config.lanes),
    workerMaxAttempts: target.config.operational.workerMaxAttempts,
    // The gate exists to keep a hook from flooding a local model with transcript. A command
    // recording one observation about itself is neither.
    acceptHookCapture: true,
  };
}

import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { SYSTEM_SESSION_IDENTITY } from '../../infrastructure/graph/sessions.js';

/**
 * What happened to the substrate itself, in the substrate's own memory. An init, a schema
 * advance, a replay, and a model swap are the events that change what the substrate is or
 * what it knows how to do; everything else it does is already recorded as graph lineage or
 * as an ops ledger row.
 */
export type LifecycleEvent =
  'substrate_initialized' | 'migrations_applied' | 'replay_completed' | 'models_reconciled';

export type LifecycleEventInput = {
  readonly event: LifecycleEvent;
  /** One line, with the numbers in it: what a later recall has to be able to answer from. */
  readonly text: string;
  readonly now?: Date;
};

/**
 * A lifecycle event stored the way every other experience is stored: through intake, as an
 * observation, in the graph and the archive. Nothing about it is a separate store, so it is
 * recallable, replayable, and forgettable by the same commands as anything else.
 *
 * The bulk lane is deliberate. A lifecycle event is worth keeping and never worth serving
 * ahead of a live turn, and boot emits one while the first sessions are already connecting.
 *
 * Recording is fail-open and this never throws: a substrate too broken to store its own
 * initialization is already reporting that through the command that failed, and turning a
 * missing memory into a failed init would cost the operator the substrate they were building.
 */
export async function recordLifecycleEvent(
  deps: ReflectionIntakeDeps,
  input: LifecycleEventInput,
): Promise<void> {
  try {
    const result = await handleReflection(
      deps,
      {
        observations: [input.text],
        session_id: SYSTEM_SESSION_IDENTITY,
        lane: 'bulk',
        origin: { channel: 'system', event: input.event },
      },
      {
        identity: SYSTEM_SESSION_IDENTITY,
        ...(input.now === undefined ? {} : { now: input.now }),
      },
    );
    deps.logger.info(
      { episodeId: result.episode_id, event: input.event },
      'lifecycle event recorded',
    );
  } catch (err) {
    deps.logger.warn({ err, event: input.event }, 'lifecycle event not recorded');
  }
}

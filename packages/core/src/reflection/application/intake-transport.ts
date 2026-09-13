import type { ReflectionOrigin, ReflectionProvenance } from '@aion/protocol';
import { randomUUID } from 'node:crypto';

import { ReflectionNotStoredError } from './errors.js';
import type { IntakePayload } from './intake-codec.js';
import type { LaneDecision } from './lanes.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';
import { INDEX_POLICY_VERSION } from '../../infrastructure/sqlite/source-search-schema.js';
import type { PreparedEpisode, ReflectionContent } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';

/**
 * The intake operation's caller-facing half: what a transport hands the coordinator, and what it
 * makes of the answer.
 *
 * The coordinator is reached through this narrow shape rather than through the class, so the
 * write path names the one thing it asks for. Everything that decides which source an accepted
 * payload is happens inside the operation, under the guard; nothing here dedupes, mints an id, or
 * writes to either store.
 */
export type IntakePublisher = {
  publish(request: {
    readonly kind: 'intake';
    readonly operationId: string;
    readonly payload: unknown;
  }): Promise<PublicationOutcome>;
};

/** What the intake operation answers with once its acknowledgment has run. */
export type AcceptedSource = {
  readonly sourceId: string;
  readonly created: boolean;
  readonly turnIds: readonly string[];
};

export type IntakeRequest = {
  readonly identity: string;
  readonly sessionId: string;
  readonly prepared: PreparedEpisode;
  /** The redacted content, which is what the archive holds and a re-derivation must match. */
  readonly payload: ReflectionContent;
  readonly references: ReflectionProvenance | undefined;
  readonly origin: ReflectionOrigin | undefined;
  readonly lane: LaneDecision['lane'];
  readonly occurredAt: Date;
  /**
   * What the source's generation will owe, from the policy in force when the intent is written.
   *
   * It rides in the intent rather than being read at acknowledgment because the intent is what a
   * recovery replays: a policy published between the two would otherwise give the replay a
   * different inventory than the attempt it is finishing. Absent where nothing has published one,
   * which the acceptance records as a durable inventory obligation rather than as no work.
   */
  readonly readiness:
    { readonly policyRevision: number; readonly stageNames: readonly string[] } | undefined;
};

/**
 * A fresh delivery identity per call.
 *
 * Idempotence is not this id's job. A payload the substrate already holds resolves to its
 * original occurrence inside the operation and projects nothing, and a payload whose predecessor
 * was forgotten mints a new one; both answers come from the records under the guard. Reusing an
 * id across calls would instead replay the first call's saved result, which is the one answer
 * that cannot be right for a re-push after a forget.
 */
export function intakeOperationId(): string {
  return `intake:${randomUUID()}`;
}

export function intakePayloadOf(request: IntakeRequest): IntakePayload {
  return {
    identity: request.identity,
    sessionId: request.sessionId,
    payloadJson: JSON.stringify(request.payload),
    referencesJson: request.references === undefined ? null : JSON.stringify(request.references),
    lane: request.lane,
    originJson: request.origin === undefined ? null : JSON.stringify(request.origin),
    pipelineVersion: PIPELINE_VERSION,
    occurredAt: request.occurredAt.toISOString(),
    indexPolicy: `archive-v${String(INDEX_POLICY_VERSION)}`,
    readiness:
      request.readiness === undefined
        ? null
        : {
            policyRevision: request.readiness.policyRevision,
            stageNames: [...request.readiness.stageNames],
          },
  };
}

/**
 * Publishes one acceptance and turns the outcome into the source it accepted.
 *
 * A refusal is not an error the caller can retry into a different answer: an ambiguous key means
 * two live occurrences share a payload, and picking one would record a decision nobody made. A
 * deferral is the opposite, an answer that moved under the attempt, and saying so is what stops
 * a client believing its reflection was queued when nothing was written.
 */
export async function publishIntake(
  publications: IntakePublisher,
  request: IntakeRequest,
  operationId: string,
): Promise<AcceptedSource> {
  const outcome = await publications.publish({
    kind: 'intake',
    operationId,
    payload: intakePayloadOf(request),
  });
  if (outcome.status !== 'acknowledged') {
    throw new ReflectionNotStoredError(
      outcome.status === 'rejected' ? 'occurrence' : 'publication',
      new Error(outcome.reason),
    );
  }
  const result = outcome.result as { sourceId: string; created: boolean; turnIds: string[] };
  return { sourceId: result.sourceId, created: result.created, turnIds: [...result.turnIds] };
}

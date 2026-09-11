import { randomUUID } from 'node:crypto';

import type { RollupCoverageBinding, RollupFamilyProof } from './rollup-family-fence.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * Handing one calendar window to the coordinator.
 *
 * Everything expensive has already happened when this is called: the members are chosen, the
 * allowance is measured, the model has answered. What is left is the part that has to be inside a
 * guard, so the guard is held for exactly that and never across the synthesis.
 *
 * A refusal is an ordinary answer. The window is unchanged, nothing is recorded against it, and
 * the next pass measures it again.
 */

export type CalendarRollupRequest = {
  readonly mode: 'publish' | 'repair';
  readonly scope: RollupScope;
  readonly windowKey: string;
  readonly nodeId: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly memberIds: readonly string[];
  readonly closes: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly citations: readonly string[];
  readonly sentenceCount: number;
  readonly spanStart: Date | null;
  readonly spanEnd: Date | null;
  readonly occurredAt: Date;
  /** The window this summary covers, so the guard can ask what it holds now. */
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly memberScope: string;
  /** Every owned version the window carried when the decision was taken. */
  readonly expectedHeads: readonly string[];
  /** Which of the closure targets were standing then. */
  readonly openCloses: readonly string[];
  readonly coverage: RollupCoverageBinding;
  readonly proof: RollupFamilyProof;
};

export type CalendarRollupOutcome =
  | { readonly status: 'acknowledged'; readonly absorbed: number }
  | { readonly status: 'refused'; readonly reason: string };

export type CalendarRollupDeps = {
  readonly db?: SqliteHandle;
  readonly publications?: PublicationCoordinator;
};

async function settle(
  publications: PublicationCoordinator,
  request: Parameters<PublicationCoordinator['publish']>[0],
): Promise<Awaited<ReturnType<PublicationCoordinator['publish']>> | undefined> {
  try {
    return await publications.publish(request);
  } catch {
    return undefined;
  }
}

export async function publishCalendarRollup(
  deps: CalendarRollupDeps,
  request: CalendarRollupRequest,
): Promise<CalendarRollupOutcome> {
  const { publications } = deps;
  if (deps.db === undefined || publications === undefined) {
    return { status: 'refused', reason: 'calendar_publisher_unavailable' };
  }
  // A fresh identity per attempt. A refused attempt is immutable, and a window whose prerequisite
  // was repaired comes back as a new operation rather than reusing a settled one.
  const outcome = await settle(publications, {
    kind: 'calendar_rollup_publish',
    // The window travels in the identity: an attempt is one window's, and a receipt that names
    // which one is what makes a pending operation legible without opening its payload.
    operationId: `calendar-rollup:${request.scope}:${request.windowKey}:${randomUUID()}`,
    payload: {
      mode: request.mode,
      scope: request.scope,
      windowKey: request.windowKey,
      nodeId: request.nodeId,
      version: request.version,
      coverageKey: request.coverageKey,
      memberIds: [...request.memberIds],
      closes: [...request.closes].filter((id) => id !== request.nodeId),
      summary: request.summary,
      narrative: request.narrative,
      citations: [...request.citations],
      sentenceCount: request.sentenceCount,
      spanStart: request.spanStart?.toISOString() ?? null,
      spanEnd: request.spanEnd?.toISOString() ?? null,
      occurredAt: request.occurredAt.toISOString(),
      windowStart: request.windowStart.toISOString(),
      windowEnd: request.windowEnd.toISOString(),
      memberScope: request.memberScope,
      expectedHeads: [...request.expectedHeads].sort(),
      openCloses: [...request.openCloses].sort(),
      // The epoch the inputs were read under, carried rather than re-read: the coordinator
      // validates the binding this attempt actually used.
      coverageEpoch: request.coverage.epoch,
      ownedIds: [...request.proof.ownedIds],
      dependencies: request.proof.dependencies.map((dependency) => ({ ...dependency })),
    },
  });
  if (outcome === undefined) {
    // A coordinator error is kept to this window. A pass over a calendar is a page of independent
    // windows, and failing all of them over one leaves the rest unexamined.
    return { status: 'refused', reason: 'calendar_publication_unsettled' };
  }
  if (outcome.status !== 'acknowledged') {
    return { status: 'refused', reason: outcome.reason };
  }
  const result = outcome.result as { absorbed?: unknown };
  return {
    status: 'acknowledged',
    absorbed: typeof result.absorbed === 'number' ? result.absorbed : 0,
  };
}

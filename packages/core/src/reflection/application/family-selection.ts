import { z } from 'zod';

import {
  acknowledgeFamilyAdvance,
  discardFamilyAdvance,
  FAMILY_SELECTION_SCOPE,
  prepareFamilyAdvance,
} from './family-fence.js';
import { hasNarrativeSession } from '../../infrastructure/graph/narrative-families.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import {
  acknowledgeFamilySelection,
  readFamilySelection,
} from '../../infrastructure/sqlite/family-selection.js';

/**
 * A session's narrative family, recorded once and fenced.
 *
 * There is one family: a session's history is compressed chunk by chunk. The record still exists
 * and is still taken under the guard, because what a reader fences on is the version beside it: a
 * narrative revision binds the selection it was published under, and a revision that could not
 * name one would go on standing through any later change to how a session is narrated.
 *
 * It writes no graph. The selection is a durable fact about a session, and the graph read it makes
 * is a precondition rather than a mutation: a session the graph does not hold is one nothing can
 * be narrated for, and recording a family for it would leave a fence over nothing.
 */
export const FAMILY_EFFECT = 'session_narrative_family';

/** The one family a session's narratives belong to. */
export const NARRATIVE_FAMILY = 'chunk';

const Payload = z.strictObject({
  sessionId: z.string().min(1),
  coverageEpoch: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
});
const Data = Payload.extend({
  /** Why this attempt cannot record a selection, decided under the guard. */
  refusal: z.string().nullable(),
  observedAt: z.string().min(1),
});
const Result = z.strictObject({ family: z.literal(NARRATIVE_FAMILY) });

export const familySelectionPublication = new PublicationOperation({
  kind: 'narrative_family_selection',
  effectKinds: [FAMILY_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('family publication requires a coverage contract');
    }
    const data: z.infer<typeof Data> = {
      ...payload,
      refusal: (await hasNarrativeSession(context.graph, payload.sessionId))
        ? null
        : 'session_missing',
      observedAt: context.now.toISOString(),
    };
    return {
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [{ kind: 'relation_scope', id: payload.sessionId, scope: FAMILY_SELECTION_SCOPE }],
      effects: [{ kind: FAMILY_EFFECT, detail: { sessionId: payload.sessionId } }],
    };
  },
  check(context, data) {
    const selected = readFamilySelection(context.db, data.sessionId);
    if ((selected?.version ?? 0) !== data.expectedVersion) {
      return Promise.resolve({ status: 'deferred', reason: 'family_selection_moved' } as const);
    }
    if (data.refusal !== null) {
      return Promise.resolve({ status: 'deferred', reason: data.refusal } as const);
    }
    if (selected !== undefined) {
      return Promise.resolve({ status: 'deferred', reason: 'family_already_initialized' } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  applyGraph() {
    return Promise.resolve({ family: NARRATIVE_FAMILY } as const);
  },
  prepareSqlite(context, data) {
    prepareFamilyAdvance(
      context.db,
      data.sessionId,
      context.operationId,
      new Date(data.observedAt),
    );
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    acknowledgeFamilySelection(context.db, {
      sessionId: data.sessionId,
      expectedVersion: data.expectedVersion,
      family: NARRATIVE_FAMILY,
      operationId: context.operationId,
    });
    acknowledgeFamilyAdvance(context.db, data.sessionId, context.operationId, context.knownFrom);
    return undefined;
  },
  discardSqlite(context, data) {
    discardFamilyAdvance(context.db, data.sessionId, context.operationId);
    return undefined;
  },
});
